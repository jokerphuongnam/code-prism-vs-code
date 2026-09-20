import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import type { AnalysisResult, ProgressInfo } from "./protocol";
import type { FlatMapEntry } from "./analyzerBridge";

interface WebviewToHostMessage {
  type: "analyzeRequest" | "copyContext" | "openFile" | "requestRawJson" | "requestMembers" | "requestFilePreview" | "webviewError" | "ready";
  filePath?: string;
  message?: string;
  nodeId?: string;
  data?: { file: string; line: number; col: number };
}

export class ExplorerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "swiftPrismExplorer";

  private view?: vscode.WebviewView;
  private onAnalyzeRequest?: () => void;
  private onCopyContext?: (nodeId: string) => void;
  private onOpenFile?: (data: { file: string; line: number; col: number }) => void;
  private onRequestRawJson?: () => void;
  private onRequestMembers?: (nodeId: string) => void;
  private onRequestFilePreview?: (nodeId: string, filePath: string) => void;
  private onWebviewError?: (message: string) => void;

  constructor(private readonly extensionUri: vscode.Uri) {}

  setAnalyzeHandler(handler: () => void): void { this.onAnalyzeRequest = handler; }
  setCopyContextHandler(handler: (nodeId: string) => void): void { this.onCopyContext = handler; }
  setOpenFileHandler(handler: (data: { file: string; line: number; col: number }) => void): void { this.onOpenFile = handler; }
  setRequestRawJsonHandler(handler: () => void): void { this.onRequestRawJson = handler; }
  setRequestMembersHandler(handler: (nodeId: string) => void): void { this.onRequestMembers = handler; }
  setRequestFilePreviewHandler(handler: (nodeId: string, filePath: string) => void): void { this.onRequestFilePreview = handler; }
  setWebviewErrorHandler(handler: (message: string) => void): void { this.onWebviewError = handler; }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist-webview"),
      ],
    };

    webviewView.webview.onDidReceiveMessage((msg: WebviewToHostMessage) => {
      if (msg.type === "analyzeRequest" && this.onAnalyzeRequest) this.onAnalyzeRequest();
      if (msg.type === "copyContext" && msg.nodeId && this.onCopyContext) this.onCopyContext(msg.nodeId);
      if (msg.type === "openFile" && msg.data && this.onOpenFile) this.onOpenFile(msg.data);
      if (msg.type === "requestRawJson" && this.onRequestRawJson) this.onRequestRawJson();
      if (msg.type === "requestMembers" && msg.nodeId && this.onRequestMembers) this.onRequestMembers(msg.nodeId);
      if (msg.type === "requestFilePreview" && msg.nodeId && msg.filePath && this.onRequestFilePreview) this.onRequestFilePreview(msg.nodeId, msg.filePath);
      if (msg.type === "webviewError" && msg.message && this.onWebviewError) this.onWebviewError(msg.message);
    });

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
  }

  sendProgress(progress: ProgressInfo): void { this.view?.webview.postMessage({ type: "progress", progress }); }
  sendResult(result: AnalysisResult): void { this.view?.webview.postMessage({ type: "analysisResult", payload: result }); }
  sendError(message: string): void { this.view?.webview.postMessage({ type: "error", message }); }
  sendMappingData(entries: FlatMapEntry[]): void { this.view?.webview.postMessage({ type: "mappingData", payload: entries }); }
  sendMemberDetail(parentId: string, result: AnalysisResult): void { this.view?.webview.postMessage({ type: "memberDetail", parentId, payload: result }); }
  sendFilePreview(preview: { nodeId: string; previewType: string; data: string; fileName: string }): void { this.view?.webview.postMessage({ type: "filePreview", payload: preview }); }
  sendContextCopied(tokenEstimate: number): void { this.view?.webview.postMessage({ type: "contextCopied", tokenEstimate }); }
  sendSemanticContextProgress(progress: { total: number; completed: number; cached: number; llmUsed: boolean }): void { this.view?.webview.postMessage({ type: "semanticContextProgress", progress }); }
  sendSemanticContextComplete(stats: { enrichedCount: number; cachedCount: number; llmUsed: boolean }): void { this.view?.webview.postMessage({ type: "semanticContextComplete", ...stats }); }
  sendNodeContextUpdate(nodeId: string, context: string): void { this.view?.webview.postMessage({ type: "nodeContextUpdate", nodeId, context }); }
  sendPendingContextIds(nodeIds: string[]): void { this.view?.webview.postMessage({ type: "pendingContextIds", nodeIds }); }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const templatePath = path.join(__dirname, "webview", "index.html");
    let template: string;

    try {
      template = fs.readFileSync(templatePath, "utf-8");
    } catch {
      return this.getFallbackHtml(webview);
    }

    const distPath = path.join(this.extensionUri.fsPath, "dist-webview");
    const jsFile = this.findAsset(distPath, ".js");
    const cssFile = this.findAsset(distPath, ".css");

    const jsUri = jsFile ? webview.asWebviewUri(vscode.Uri.file(jsFile)) : null;
    const cssUri = cssFile ? webview.asWebviewUri(vscode.Uri.file(cssFile)) : null;

    const cssTag = cssUri ? `<link rel="stylesheet" href="${cssUri}">` : "";
    const scriptTag = jsUri
      ? `<script src="${jsUri}"></script>`
      : `<p style="color:#ccc;padding:20px;">Webview not built. Run: <code>cd extension/webview && npm run build</code></p>`;

    return template
      .replace(/\{\{cspSource\}\}/g, webview.cspSource)
      .replace("{{cssTag}}", cssTag)
      .replace("{{scriptTag}}", scriptTag);
  }

  private getFallbackHtml(webview: vscode.Webview): string {
    const distPath = path.join(this.extensionUri.fsPath, "dist-webview");
    const jsFile = this.findAsset(distPath, ".js");
    const jsUri = jsFile ? webview.asWebviewUri(vscode.Uri.file(jsFile)) : null;

    return `<!DOCTYPE html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${webview.cspSource}; style-src 'unsafe-inline';">
      <style>*{margin:0;padding:0;box-sizing:border-box}html,body,#root{width:100%;height:100%;overflow:hidden}</style>
      </head><body><div id="root"></div>
      ${jsUri ? `<script src="${jsUri}"></script>` : "<p>Webview not built.</p>"}
      </body></html>`;
  }

  private findAsset(dir: string, ext: string): string | null {
    try {
      const files = fs.readdirSync(dir).filter((f: string) => f.endsWith(ext));
      if (files.length === 0) return null;
      const primary = files.find((f: string) => f === `webview${ext}`) ?? files[files.length - 1];
      return path.join(dir, primary);
    } catch {
      return null;
    }
  }
}
