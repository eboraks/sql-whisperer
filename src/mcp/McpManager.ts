import * as http from 'http';
import * as vscode from 'vscode';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { ConnectionManager } from '../db/ConnectionManager';
import type { QueryResultsSnapshot } from '../shared/messages';

export class McpManager implements vscode.Disposable {
  private httpServer?: http.Server;
  private mcpServer?: Server;
  private activeSessions = new Map<string, SSEServerTransport>();
  private statusBarItem: vscode.StatusBarItem;
  private lastResults?: QueryResultsSnapshot;

  constructor(private connectionManager: ConnectionManager) {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  }

  public setLastResults(snapshot: QueryResultsSnapshot): void {
    this.lastResults = snapshot;
  }

  async start(port: number): Promise<void> {
    if (this.httpServer) { this.stop(); }

    const mcpServer = new Server(
      { name: 'sql-whisperer-mcp', version: '0.1.0' },
      { capabilities: { tools: {} } }
    );

    this.registerTools(mcpServer);

    this.httpServer = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

      const url = new URL(req.url || '/', `http://localhost:${port}`);

      if (req.method === 'GET' && url.pathname === '/sse') {
        const transport = new SSEServerTransport('/message', res);
        this.activeSessions.set(transport.sessionId, transport);
        res.on('close', () => this.activeSessions.delete(transport.sessionId));
        await mcpServer.connect(transport);
      } else if (req.method === 'POST' && url.pathname === '/message') {
        const sessionId = url.searchParams.get('sessionId');
        const transport = sessionId ? this.activeSessions.get(sessionId) : undefined;
        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('No active session');
        }
      } else {
        res.writeHead(404); res.end();
      }
    });

    return new Promise((resolve, reject) => {
      this.httpServer!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          vscode.window.showWarningMessage(
            `SQL Whisperer MCP server port ${port} is already in use. Change sqlwhisperer.mcp.port.`
          );
        }
        reject(err);
      });

      this.httpServer!.listen(port, () => {
        this.mcpServer = mcpServer;
        this.statusBarItem.text = `$(database) MCP :${port}`;
        this.statusBarItem.tooltip = `SQL Whisperer MCP Server\nhttp://localhost:${port}/sse`;
        this.statusBarItem.show();
        console.log(`[SqlWhisperer] MCP server started on http://localhost:${port}/sse`);
        resolve();
      });
    });
  }

  stop(): void {
    for (const [, transport] of this.activeSessions) {
      try { transport.close?.(); } catch { /* ignore */ }
    }
    this.activeSessions.clear();
    this.httpServer?.close();
    this.httpServer = undefined;
    this.mcpServer?.close();
    this.mcpServer = undefined;
    this.statusBarItem.hide();
  }

  dispose(): void {
    this.stop();
    this.statusBarItem.dispose();
  }

  private registerTools(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'sql_query',
          description: 'Execute a SQL query against the connected database. Supports SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, etc.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'The SQL query to execute' },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_schema',
          description: 'Get the full database schema: all tables, columns (with types and constraints), and foreign key relationships. Use this first before writing any queries.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              table: { type: 'string', description: 'Optional: get schema for a specific table only' },
            },
          },
        },
        {
          name: 'fix_query',
          description: 'Analyze a SQL query that produced an error and return a corrected version with explanation.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'The failing SQL query' },
              error: { type: 'string', description: 'The error message from the database' },
            },
            required: ['query', 'error'],
          },
        },
        {
          name: 'explain_query',
          description: 'Get a natural language explanation of what a SQL query does.',
          inputSchema: {
            type: 'object' as const,
            properties: {
              query: { type: 'string', description: 'The SQL query to explain' },
            },
            required: ['query'],
          },
        },
        {
          name: 'read_query_results',
          description: 'Read the latest query results from the SQL Whisperer extension without re-running queries.',
          inputSchema: { type: 'object' as const, properties: {} },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
      if (request.params.name === 'read_query_results') {
        return this.handleReadQueryResults();
      }

      if (request.params.name === 'fix_query' || request.params.name === 'explain_query') {
        return this.handleAgentQuery(request.params.name, request.params.arguments);
      }

      if (!this.connectionManager.isConnected) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Not connected to a database. Use the SQL Whisperer extension to connect first.' }],
        };
      }

      switch (request.params.name) {
        case 'sql_query':
          return this.handleQuery(request.params.arguments.query);
        case 'get_schema':
          return this.handleGetSchema(request.params.arguments?.table);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
      }
    });
  }

  private async handleQuery(sql: string) {
    try {
      const result = await this.connectionManager.query(sql);
      const isSelect = result.rows.length > 0;
      const output = isSelect
        ? { columns: result.columns, rows: result.rows, rowCount: result.rows.length, executionMs: result.executionMs }
        : { rowsAffected: result.rowsAffected, executionMs: result.executionMs };
      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    } catch (error: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: `SQL Error: ${error.message}` }],
      };
    }
  }

  private async handleGetSchema(tableName?: string) {
    try {
      const schema = this.connectionManager.cachedSchema;
      if (!schema) {
        return { content: [{ type: 'text', text: 'Schema not loaded. Run a query or refresh the Schema Explorer first.' }] };
      }

      const tables = tableName
        ? schema.tables.filter(t => t.name.toLowerCase() === tableName.toLowerCase())
        : schema.tables;

      const output = {
        dbType: schema.dbType,
        database: schema.database,
        tables: tables.map(t => ({
          schema: t.schema,
          name: t.name,
          columns: t.columns.map(c => ({
            name: c.name,
            type: c.dataType,
            nullable: c.nullable,
            primaryKey: c.isPrimaryKey,
            default: c.defaultValue,
          })),
          foreignKeys: t.foreignKeys.map(fk => ({
            column: fk.columnName,
            references: `${fk.referencedTable}.${fk.referencedColumn}`,
          })),
        })),
      };

      return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
    } catch (error: any) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  }

  private handleReadQueryResults() {
    if (!this.lastResults) {
      return {
        content: [{ type: 'text', text: 'No query results yet. Run a SQL query first (Cmd+Enter in a .sql file).' }],
      };
    }

    const r = this.lastResults;
    const result: any = {
      queryType: r.queryType,
      query: r.query,
      timestamp: new Date(r.timestamp).toISOString(),
      executionMs: r.executionMs,
    };

    if (r.rows) {
      result.rowCount = r.rows.length;
      result.columns = r.columns;
      result.rows = r.rows.slice(0, 50);
    }
    if (r.rowsAffected !== undefined) { result.rowsAffected = r.rowsAffected; }
    if (r.error) { result.error = r.error; }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }

  /** Pass-through to Claude for fix/explain — these need LLM reasoning */
  private async handleAgentQuery(tool: string, args: any) {
    const config = vscode.workspace.getConfiguration('sqlwhisperer');
    const apiKey = config.get<string>('anthropic.apiKey') || '';
    if (!apiKey) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'No Anthropic API key configured. Set sqlwhisperer.anthropic.apiKey.' }],
      };
    }

    try {
      const Anthropic = require('@anthropic-ai/sdk').default;
      const anthropic = new Anthropic({ apiKey });

      let prompt = '';
      if (tool === 'fix_query') {
        const schema = this.connectionManager.cachedSchema;
        const schemaStr = schema
          ? schema.tables.map(t => `${t.name}(${t.columns.map(c => c.name).join(', ')})`).join('\n')
          : 'Schema not available';
        prompt = `Fix this SQL query that produced an error.\n\nQuery:\n${args.query}\n\nError:\n${args.error}\n\nSchema:\n${schemaStr}\n\nReturn the corrected query and a brief explanation.`;
      } else {
        prompt = `Explain what this SQL query does in plain English:\n\n${args.query}`;
      }

      const response = await anthropic.messages.create({
        model: config.get<string>('anthropic.model') || 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return { content: [{ type: 'text', text }] };
    } catch (err: any) {
      return { isError: true, content: [{ type: 'text', text: `Claude API error: ${err.message}` }] };
    }
  }
}
