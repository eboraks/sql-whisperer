import * as vscode from 'vscode';
import type { GraphPayload, GraphViewMessage, GraphViewRequest, SchemaInfo } from '../shared/messages';

export class SchemaGraphProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sqlwhisperer.schemaGraph';
  private view?: vscode.WebviewView;
  private pendingPayload?: GraphPayload;
  private webviewReady = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'out', 'webview')],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    this.webviewReady = false;

    webviewView.onDidDispose(() => { this.webviewReady = false; });

    webviewView.webview.onDidReceiveMessage(async (msg: GraphViewRequest) => {
      switch (msg.command) {
        case 'webview:ready':
          this.webviewReady = true;
          if (this.pendingPayload) {
            this.postMessage({ command: 'graph:showResults', data: this.pendingPayload });
            this.pendingPayload = undefined;
          }
          break;
        case 'graph:exportPng':
          // handled inside webview
          break;
      }
    });
  }

  /** Build graph from full schema — tables as nodes, FK relationships as edges */
  public showSchemaGraph(schema: SchemaInfo): void {
    const nodes = schema.tables.map(t => ({
      id: `${t.schema}.${t.name}`,
      label: t.name,
      schema: t.schema,
      columnCount: t.columns.length,
      properties: Object.fromEntries(
        t.columns.slice(0, 8).map(c => [c.name, c.dataType])
      ),
    }));

    const edges: GraphPayload['edges'] = [];
    for (const table of schema.tables) {
      for (const fk of table.foreignKeys) {
        const sourceId = `${table.schema}.${table.name}`;
        // Try to find the referenced table's schema
        const refTable = schema.tables.find(t => t.name === fk.referencedTable);
        const targetId = refTable
          ? `${refTable.schema}.${fk.referencedTable}`
          : `${table.schema}.${fk.referencedTable}`;

        edges.push({
          id: `${sourceId}-${fk.columnName}->${targetId}`,
          source: sourceId,
          target: targetId,
          label: `${fk.columnName} → ${fk.referencedColumn}`,
          sourceColumn: fk.columnName,
          targetColumn: fk.referencedColumn,
        });
      }
    }

    this.showGraph({
      nodes,
      edges,
      queryType: 'schema',
      tableCount: nodes.length,
      edgeCount: edges.length,
    });
  }

  /** Show a join-based graph derived from a SELECT query result */
  public showQueryGraph(payload: GraphPayload): void {
    this.showGraph(payload);
  }

  private showGraph(payload: GraphPayload): void {
    this.pendingPayload = payload;
    if (this.view && this.webviewReady) {
      this.view.show(true);
      this.postMessage({ command: 'graph:showResults', data: payload });
      this.pendingPayload = undefined;
    } else if (this.view) {
      this.view.show(true);
    }
  }

  public clear(): void {
    this.postMessage({ command: 'graph:clear' });
  }

  private postMessage(msg: GraphViewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'schemaGraph.js')
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Schema Graph</title>
</head>
<body>
  <div id="graph-root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
