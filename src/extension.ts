import * as vscode from 'vscode';
import { ConnectionManager, type DbConnectionOptions } from './db/ConnectionManager';
import { SchemaProvider } from './views/SchemaProvider';
import { ResultsPanel } from './panels/ResultsPanel';
import { SchemaGraphProvider } from './graph/SchemaGraphProvider';
import { SqlWhispererChat } from './features/SqlWhispererChat';
import { McpManager } from './mcp/McpManager';
import type { QueryResultsSnapshot } from './shared/messages';

export function activate(context: vscode.ExtensionContext) {
  console.log('[SqlWhisperer] Extension activating...');

  // ─── Core Services ─────────────────────────────────────────────────────────
  const connectionManager = new ConnectionManager();
  context.subscriptions.push(connectionManager);

  // ─── Schema Explorer (Sidebar Tree View) ──────────────────────────────────
  const schemaProvider = new SchemaProvider(connectionManager);
  const treeView = vscode.window.createTreeView('sqlwhisperer.schema', {
    treeDataProvider: schemaProvider,
    dragAndDropController: schemaProvider,
  });
  context.subscriptions.push(treeView);

  // ─── Results Panel (Bottom Panel Webview) ──────────────────────────────────
  const resultsPanel = new ResultsPanel(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ResultsPanel.viewType, resultsPanel)
  );

  // ─── Schema Graph Panel (Bottom Panel Webview) ────────────────────────────
  const graphProvider = new SchemaGraphProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SchemaGraphProvider.viewType,
      graphProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ─── MCP Server ────────────────────────────────────────────────────────────
  const mcpManager = new McpManager(connectionManager);
  context.subscriptions.push(mcpManager);

  const startMcpIfEnabled = () => {
    const cfg = vscode.workspace.getConfiguration('sqlwhisperer');
    if (cfg.get<boolean>('mcp.enabled', true)) {
      const port = cfg.get<number>('mcp.port', 3331);
      mcpManager.start(port).catch(err => {
        console.error('[SqlWhisperer] Failed to start MCP server:', err.message);
      });
    }
  };
  startMcpIfEnabled();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('sqlwhisperer.mcp')) {
        const cfg = vscode.workspace.getConfiguration('sqlwhisperer');
        if (cfg.get<boolean>('mcp.enabled', true)) {
          const port = cfg.get<number>('mcp.port', 3331);
          mcpManager.start(port).catch(err =>
            console.error('[SqlWhisperer] Failed to restart MCP:', err.message)
          );
        } else {
          mcpManager.stop();
        }
      }
    })
  );

  // ─── Helper: detect dbType from a connection string scheme ───────────────
  const dbTypeFromScheme = (connStr: string): DbConnectionOptions['dbType'] => {
    const scheme = connStr.split('://')[0]?.toLowerCase() || '';
    if (scheme.startsWith('postgres')) { return 'postgresql'; }
    if (scheme === 'mysql' || scheme === 'mariadb') { return 'mysql'; }
    if (scheme === 'mssql' || scheme === 'sqlserver') { return 'mssql'; }
    return 'postgresql'; // default
  };

  // ─── Helper: extract database name from a connection string for display ──
  const dbNameFromConnStr = (connStr: string): string => {
    try {
      const url = new URL(connStr);
      return url.pathname.replace(/^\//, '') || url.hostname || 'database';
    } catch {
      return 'database';
    }
  };

  // ─── Helper: build connection options ─────────────────────────────────────
  const getConnectionOptions = async (): Promise<DbConnectionOptions | null> => {
    const cfg = vscode.workspace.getConfiguration('sqlwhisperer');

    // Connection string takes priority (check SecretStorage first, then settings)
    const secretConnStr = await context.secrets.get('sqlwhisperer.connectionString');
    const configConnStr = cfg.get<string>('connectionString');
    const connectionString = secretConnStr || configConnStr || '';

    if (connectionString) {
      const dbType = dbTypeFromScheme(connectionString);
      return {
        dbType,
        connectionString,
        database: dbNameFromConnStr(connectionString),
      };
    }

    // Fall back to individual fields
    const dbType = cfg.get<string>('dbType') as DbConnectionOptions['dbType'];
    const database = cfg.get<string>('database');

    if (!database) {
      vscode.window.showErrorMessage(
        'No connection configured. Set a connection string or database name in settings.'
      );
      return null;
    }

    const configPassword = cfg.get<string>('password');
    const secretPassword = await context.secrets.get('sqlwhisperer.password');

    return {
      dbType: dbType || 'postgresql',
      host: cfg.get<string>('host') || 'localhost',
      port: cfg.get<number>('port') || 5432,
      database,
      username: cfg.get<string>('username') || '',
      password: secretPassword || configPassword || '',
      ssl: cfg.get<boolean>('ssl') || false,
    };
  };

  // ─── Command: Connect ──────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.connect', async () => {
      const opts = await getConnectionOptions();
      if (!opts) { return; }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'SQL Whisperer: Connecting...' },
        async () => {
          try {
            await connectionManager.connect(opts);
            const schema = await connectionManager.refreshSchema();
            schemaProvider.refresh(schema);
            graphProvider.showSchemaGraph(schema);
            vscode.window.showInformationMessage(
              `✅ Connected to ${opts.dbType} — ${opts.database} (${schema.tables.length} tables)`
            );
          } catch (err: any) {
            vscode.window.showErrorMessage(`Connection failed: ${err.message}`);
          }
        }
      );
    })
  );

  // ─── Command: Disconnect ───────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.disconnect', async () => {
      await connectionManager.disconnect();
      schemaProvider.refresh();
      graphProvider.clear();
      vscode.window.showInformationMessage('SQL Whisperer: Disconnected.');
    })
  );

  // ─── Command: Refresh Schema ───────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.refreshSchema', async () => {
      if (!connectionManager.isConnected) {
        vscode.window.showWarningMessage('Not connected. Use SQL Whisperer: Connect first.');
        return;
      }
      try {
        const schema = await connectionManager.refreshSchema();
        schemaProvider.refresh(schema);
        graphProvider.showSchemaGraph(schema);
        vscode.window.showInformationMessage(`Schema refreshed — ${schema.tables.length} tables.`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Schema refresh failed: ${err.message}`);
      }
    })
  );

  // ─── Command: Search Schema ────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.searchSchema', async () => {
      const term = await vscode.window.showInputBox({
        placeHolder: 'Search tables and columns...',
        title: 'Search Schema Explorer',
        prompt: 'Enter search term to filter (leave empty to clear)',
      });
      if (term !== undefined) {
        await schemaProvider.search(term);
      }
    })
  );

  // ─── Command: Show Schema Graph ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.showSchemaGraph', () => {
      vscode.commands.executeCommand('sqlwhisperer.schemaGraph.focus');
      const schema = connectionManager.cachedSchema;
      if (schema) {
        graphProvider.showSchemaGraph(schema);
      }
    })
  );

  // ─── Command: Set Password ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.setPassword', async () => {
      const password = await vscode.window.showInputBox({
        prompt: 'Enter your database password',
        password: true,
        placeHolder: 'Password',
      });
      if (password !== undefined) {
        await context.secrets.store('sqlwhisperer.password', password);
        vscode.window.showInformationMessage('Password saved securely.');
      }
    })
  );

  // ─── Command: Set Connection String ──────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.setConnectionString', async () => {
      const connStr = await vscode.window.showInputBox({
        prompt: 'Enter your connection string (e.g. postgresql://user:pass@host:5432/dbname)',
        password: true,
        placeHolder: 'postgresql://user:pass@localhost:5432/mydb',
      });
      if (connStr !== undefined) {
        await context.secrets.store('sqlwhisperer.connectionString', connStr);
        vscode.window.showInformationMessage('Connection string saved securely.');
      }
    })
  );

  // ─── Command: Set API Key ──────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Anthropic API key (sk-ant-...)',
        password: true,
        placeHolder: 'sk-ant-...',
      });
      if (key !== undefined) {
        await context.secrets.store('sqlwhisperer.anthropic.apiKey', key);
        vscode.window.showInformationMessage('Anthropic API key saved securely.');
      }
    })
  );

  // ─── Command: Run Query ────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('sqlwhisperer.runQuery', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage('No active editor found.');
        return;
      }

      // Use selection if present, otherwise full document
      const selection = editor.selection;
      const query = selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(selection);

      if (!query.trim()) {
        vscode.window.showErrorMessage('Query is empty.');
        return;
      }

      if (!connectionManager.isConnected) {
        const connect = await vscode.window.showWarningMessage(
          'Not connected to a database.',
          'Connect Now'
        );
        if (connect) {
          await vscode.commands.executeCommand('sqlwhisperer.connect');
        }
        return;
      }

      resultsPanel.setLoading();
      vscode.commands.executeCommand('workbench.view.extension.sqlwhisperer');

      const startMs = Date.now();
      try {
        const result = await connectionManager.query(query);
        const executionMs = Date.now() - startMs;

        const queryType = detectQueryType(query);
        const snapshot: QueryResultsSnapshot = {
          query,
          queryType,
          rows: result.rows,
          columns: result.columns,
          rowsAffected: result.rowsAffected,
          executionMs: result.executionMs,
          timestamp: Date.now(),
        };

        resultsPanel.updateResults(snapshot);
        SqlWhispererChat.setLastResults(snapshot);
        mcpManager.setLastResults(snapshot);

        const rowInfo = queryType === 'select'
          ? `${result.rows.length} rows returned`
          : `${result.rowsAffected ?? 0} rows affected`;
        vscode.window.showInformationMessage(
          `✅ Query executed in ${executionMs}ms — ${rowInfo}`
        );
      } catch (err: any) {
        const snapshot: QueryResultsSnapshot = {
          query,
          queryType: detectQueryType(query),
          error: err.message,
          timestamp: Date.now(),
          executionMs: Date.now() - startMs,
        };
        resultsPanel.updateResults(snapshot);
        SqlWhispererChat.setLastResults(snapshot);
        mcpManager.setLastResults(snapshot);
        vscode.window.showErrorMessage(`SQL Error: ${err.message}`);
      }
    })
  );

  // ─── Auto-connect on activation if configured ──────────────────────────────
  getConnectionOptions().then(opts => {
    if (opts?.database) {
      connectionManager.connect(opts).then(async () => {
        const schema = await connectionManager.refreshSchema();
        schemaProvider.refresh(schema);
        graphProvider.showSchemaGraph(schema);
        console.log(`[SqlWhisperer] Auto-connected to ${opts.dbType}:${opts.database}`);
      }).catch(err => {
        console.log('[SqlWhisperer] Auto-connect skipped:', err.message);
      });
    }
  });

  // ─── SQL Autocomplete (Table & Column Names) ─────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('sql', {
      provideCompletionItems(document, position) {
        const tables = schemaProvider.getTables();
        if (tables.length === 0) { return []; }

        const lineText = document.lineAt(position).text;
        const textBefore = lineText.substring(0, position.character);

        // After "tableName." → suggest columns for that table
        const dotMatch = textBefore.match(/(\w+)\.\s*$/);
        if (dotMatch) {
          const table = schemaProvider.getTableByName(dotMatch[1]);
          if (table) {
            return table.columns.map((col, i) => {
              const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
              item.detail = col.dataType + (col.isPrimaryKey ? ' (PK)' : '') + (col.nullable ? '' : ' NOT NULL');
              item.sortText = String(i).padStart(4, '0');
              return item;
            });
          }
        }

        // General context → suggest table names and column names
        const items: vscode.CompletionItem[] = [];

        for (const table of tables) {
          const tableItem = new vscode.CompletionItem(table.name, vscode.CompletionItemKind.Class);
          tableItem.detail = `Table (${table.columns.length} cols)`;
          tableItem.documentation = table.columns.map(c =>
            `${c.isPrimaryKey ? '🔑 ' : ''}${c.name} ${c.dataType}`
          ).join('\n');
          items.push(tableItem);

          for (const col of table.columns) {
            const colItem = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
            colItem.detail = `${table.name}.${col.name} (${col.dataType})`;
            colItem.filterText = col.name;
            items.push(colItem);
          }
        }

        return items;
      }
    }, '.')
  );

  // ─── Chat Participant ──────────────────────────────────────────────────────
  SqlWhispererChat.register(context, schemaProvider, connectionManager);

  console.log('[SqlWhisperer] Extension activated.');
}

export function deactivate() {}

function detectQueryType(sql: string): QueryResultsSnapshot['queryType'] {
  const clean = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  if (/^(SELECT|WITH|SHOW|DESCRIBE|EXPLAIN)/.test(clean)) { return 'select'; }
  if (/^INSERT/.test(clean)) { return 'insert'; }
  if (/^UPDATE/.test(clean)) { return 'update'; }
  if (/^DELETE/.test(clean)) { return 'delete'; }
  return 'other';
}
