import * as vscode from 'vscode';
import { Cfg, SrcRange } from './cfg/model';

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 64; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export class CodeFlowPanel {
  static readonly viewType = 'codeflow.procedural';
  private extUri: vscode.Uri;
  private currentCfg: Cfg | undefined;

  private constructor(
    private panel: vscode.WebviewPanel,
    extUri: vscode.Uri,
    private onReveal: (range: SrcRange | undefined) => void,
    private onDrillIn?: (range: SrcRange) => void,
  ) {
    this.extUri = extUri;
    this.panel.onDidChangeViewState(() => this.update());
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'reveal') {
        this.onReveal(msg.range);
      } else if (msg.type === 'drillIn') {
        this.onDrillIn?.(msg.range);
      }
    });
  }

  static create(
    context: vscode.ExtensionContext,
    uri: vscode.Uri,
    cfg: Cfg,
    onReveal: (range: SrcRange | undefined) => void,
    onDrillIn?: (range: SrcRange) => void,
  ): CodeFlowPanel {
    const panel = vscode.window.createWebviewPanel(
      CodeFlowPanel.viewType,
      'Procedural CodeFlow',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview'),
        ],
      },
    );

    const instance = new CodeFlowPanel(panel, context.extensionUri, onReveal, onDrillIn);
    instance.render(cfg);
    return instance;
  }

  dispose() {
    this.panel.dispose();
  }

  updateCfg(cfg: Cfg) {
    this.render(cfg);
  }

  private render(cfg: Cfg) {
    this.currentCfg = cfg;
    const panel = this.panel;
    const webview = panel.webview;
    const nonce = getNonce();

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extUri, 'dist', 'webview', 'main.js'),
    );

    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'dist', 'webview', 'style.css'))}">
  <title>Procedural CodeFlow</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    const __CFG__ = ${JSON.stringify(cfg)};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private update() {
    if (this.panel.visible && this.currentCfg) {
      this.render(this.currentCfg);
    }
  }
}
