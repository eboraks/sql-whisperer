import * as vscode from 'vscode';
import type { QueryResultsSnapshot, ResultsViewMessage, ResultsViewRequest } from '../shared/messages';

export class ResultsPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'sqlwhisperer.results';
  private view?: vscode.WebviewView;
  private pendingSnapshot?: QueryResultsSnapshot;
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

    webviewView.webview.onDidReceiveMessage((msg: ResultsViewRequest) => {
      switch (msg.command) {
        case 'webview:ready':
          this.webviewReady = true;
          if (this.pendingSnapshot) {
            this.postMessage({ command: 'results:showData', data: this.pendingSnapshot });
            this.pendingSnapshot = undefined;
          }
          break;
        case 'results:exportCsv':
          // handled inside webview via download link
          break;
      }
    });
  }

  public updateResults(snapshot: QueryResultsSnapshot): void {
    this.pendingSnapshot = snapshot;
    if (this.view && this.webviewReady) {
      this.view.show(true);
      this.postMessage({ command: 'results:showData', data: snapshot });
      this.pendingSnapshot = undefined;
    } else if (this.view) {
      this.view.show(true);
    }
  }

  public setLoading(): void {
    this.postMessage({ command: 'results:loading' });
  }

  private postMessage(msg: ResultsViewMessage): void {
    this.view?.webview.postMessage(msg);
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'out', 'webview', 'resultsPanel.js')
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SQL Results</title>
</head>
<body>
  <div id="results-root"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
