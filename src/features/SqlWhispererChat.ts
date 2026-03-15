import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';
import type { SchemaProvider } from '../views/SchemaProvider';
import type { QueryResultsSnapshot } from '../shared/messages';
import type { ConnectionManager } from '../db/ConnectionManager';

export class SqlWhispererChat {
  private static instance: SqlWhispererChat;
  private lastResults?: QueryResultsSnapshot;

  constructor(
    private schemaProvider: SchemaProvider,
    private connectionManager: ConnectionManager,
    private context: vscode.ExtensionContext
  ) {
    SqlWhispererChat.instance = this;
  }

  public static register(
    context: vscode.ExtensionContext,
    schemaProvider: SchemaProvider,
    connectionManager: ConnectionManager
  ) {
    const handler = new SqlWhispererChat(schemaProvider, connectionManager, context);

    const participant = vscode.chat.createChatParticipant(
      'sqlwhisperer',
      (request, chatContext, response, token) =>
        handler.handleRequest(request, chatContext, response, token)
    );

    participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg');
    context.subscriptions.push(participant);
  }

  public static setLastResults(snapshot: QueryResultsSnapshot): void {
    if (SqlWhispererChat.instance) {
      SqlWhispererChat.instance.lastResults = snapshot;
    }
  }

  async handleRequest(
    request: vscode.ChatRequest,
    _chatContext: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken
  ): Promise<void> {
    stream.progress('Analyzing schema context...');

    // ── 1. Get API Key ──────────────────────────────────────────────────────
    const config = vscode.workspace.getConfiguration('sqlwhisperer');
    let apiKey = await this.context.secrets.get('sqlwhisperer.anthropic.apiKey');
    if (!apiKey) { apiKey = config.get<string>('anthropic.apiKey') || ''; }
    const model = config.get<string>('anthropic.model') || 'claude-sonnet-4-20250514';

    if (!apiKey) {
      stream.markdown(
        '⚠️ **No Anthropic API key configured.**\n\n' +
        'Run the command **SQL Whisperer: Set Anthropic API Key** to set it securely,\n' +
        'or add `sqlwhisperer.anthropic.apiKey` to your VS Code settings.'
      );
      return;
    }

    // ── 2. Build schema context ─────────────────────────────────────────────
    const tables = this.schemaProvider.getTables();
    const schema = this.connectionManager.cachedSchema;

    let schemaContext = '## Current Database Schema\n\n';
    if (!this.connectionManager.isConnected || tables.length === 0) {
      schemaContext += 'No database connected or schema not yet loaded.\n';
    } else {
      schemaContext += `Database: ${schema?.database || 'unknown'} (${schema?.dbType || 'unknown'})\n`;
      schemaContext += `Tables: ${tables.length}\n\n`;
      for (const table of tables.slice(0, 40)) {
        const cols = table.columns.map(c =>
          `${c.isPrimaryKey ? '🔑 ' : ''}${c.name} ${c.dataType}${c.nullable ? '' : ' NOT NULL'}`
        ).join(', ');
        schemaContext += `**${table.schema}.${table.name}** — ${cols}\n`;
        if (table.foreignKeys.length > 0) {
          const fks = table.foreignKeys.map(fk =>
            `${fk.columnName} → ${fk.referencedTable}.${fk.referencedColumn}`
          ).join(', ');
          schemaContext += `  FK: ${fks}\n`;
        }
      }
      if (tables.length > 40) { schemaContext += `... (${tables.length - 40} more tables truncated)\n`; }
    }

    // ── 3. Build last results context ───────────────────────────────────────
    let resultsContext = '';
    if (this.lastResults) {
      const r = this.lastResults;
      resultsContext = '\n\n## Latest Query Results\n';
      resultsContext += `Query (${r.queryType.toUpperCase()}) executed at ${new Date(r.timestamp).toISOString()}:\n`;
      resultsContext += '```sql\n' + r.query + '\n```\n';
      if (r.queryType === 'select' && r.rows) {
        const preview = r.rows.slice(0, 30);
        resultsContext += `Returned ${r.rows.length} rows (${r.executionMs}ms). First ${preview.length}:\n`;
        resultsContext += '```json\n' + JSON.stringify(preview, null, 2) + '\n```\n';
        if (r.columns) {
          resultsContext += `Columns: ${r.columns.join(', ')}\n`;
        }
      } else if (r.rowsAffected !== undefined) {
        resultsContext += `Affected ${r.rowsAffected} rows.\n`;
      }
      if (r.error) {
        resultsContext += `\n⚠️ Last error: ${r.error}\n`;
      }
    }

    // ── 4. Load skill instructions from settings ────────────────────────────
    const introspectionSkill = config.get<string>('agent.introspectionSkill') || '';
    const agentRules = config.get<string>('agent.rules') || '';

    // ── 5. Build system prompt ──────────────────────────────────────────────
    const systemPrompt = `You are a SQL expert assistant named "SQL Whisperer". Your goal is to help the user write, debug, and optimize SQL queries based on their specific database schema.

${schemaContext}
${resultsContext}

## Introspection Skill
${introspectionSkill}

## General Rules
${agentRules}

When writing SQL:
- Always use table and column names that exist in the schema above
- Include schema prefix when there are multiple schemas
- Format SQL queries in \`\`\`sql code blocks
- Explain your reasoning briefly before showing the query`;

    // ── 6. Call Claude API ──────────────────────────────────────────────────
    try {
      const anthropic = new Anthropic({ apiKey });

      const response = await anthropic.messages.create({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: request.prompt }],
        stream: true,
      });

      for await (const event of response) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          stream.markdown(event.delta.text);
        }
      }
    } catch (err: any) {
      stream.markdown(`\n\n❌ **Claude API Error:** ${err.message}`);
    }
  }
}
