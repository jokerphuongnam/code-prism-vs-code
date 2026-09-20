"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExplorerViewProvider = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
class ExplorerViewProvider {
    extensionUri;
    static viewType = "swiftPrismExplorer";
    view;
    onAnalyzeRequest;
    onCopyContext;
    onOpenFile;
    onRequestRawJson;
    onRequestMembers;
    onRequestFilePreview;
    onWebviewError;
    constructor(extensionUri) {
        this.extensionUri = extensionUri;
    }
    setAnalyzeHandler(handler) { this.onAnalyzeRequest = handler; }
    setCopyContextHandler(handler) { this.onCopyContext = handler; }
    setOpenFileHandler(handler) { this.onOpenFile = handler; }
    setRequestRawJsonHandler(handler) { this.onRequestRawJson = handler; }
    setRequestMembersHandler(handler) { this.onRequestMembers = handler; }
    setRequestFilePreviewHandler(handler) { this.onRequestFilePreview = handler; }
    setWebviewErrorHandler(handler) { this.onWebviewError = handler; }
    resolveWebviewView(webviewView, _context, _token) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, "dist-webview"),
            ],
        };
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg.type === "analyzeRequest" && this.onAnalyzeRequest)
                this.onAnalyzeRequest();
            if (msg.type === "copyContext" && msg.nodeId && this.onCopyContext)
                this.onCopyContext(msg.nodeId);
            if (msg.type === "openFile" && msg.data && this.onOpenFile)
                this.onOpenFile(msg.data);
            if (msg.type === "requestRawJson" && this.onRequestRawJson)
                this.onRequestRawJson();
            if (msg.type === "requestMembers" && msg.nodeId && this.onRequestMembers)
                this.onRequestMembers(msg.nodeId);
            if (msg.type === "requestFilePreview" && msg.nodeId && msg.filePath && this.onRequestFilePreview)
                this.onRequestFilePreview(msg.nodeId, msg.filePath);
            if (msg.type === "webviewError" && msg.message && this.onWebviewError)
                this.onWebviewError(msg.message);
        });
        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    }
    sendProgress(progress) { this.view?.webview.postMessage({ type: "progress", progress }); }
    sendResult(result) { this.view?.webview.postMessage({ type: "analysisResult", payload: result }); }
    sendError(message) { this.view?.webview.postMessage({ type: "error", message }); }
    sendMappingData(entries) { this.view?.webview.postMessage({ type: "mappingData", payload: entries }); }
    sendMemberDetail(parentId, result) { this.view?.webview.postMessage({ type: "memberDetail", parentId, payload: result }); }
    sendFilePreview(preview) { this.view?.webview.postMessage({ type: "filePreview", payload: preview }); }
    sendContextCopied(tokenEstimate) { this.view?.webview.postMessage({ type: "contextCopied", tokenEstimate }); }
    sendSemanticContextProgress(progress) { this.view?.webview.postMessage({ type: "semanticContextProgress", progress }); }
    sendSemanticContextComplete(stats) { this.view?.webview.postMessage({ type: "semanticContextComplete", ...stats }); }
    sendNodeContextUpdate(nodeId, context) { this.view?.webview.postMessage({ type: "nodeContextUpdate", nodeId, context }); }
    sendPendingContextIds(nodeIds) { this.view?.webview.postMessage({ type: "pendingContextIds", nodeIds }); }
    getHtmlForWebview(webview) {
        const templatePath = path.join(__dirname, "webview", "index.html");
        let template;
        try {
            template = fs.readFileSync(templatePath, "utf-8");
        }
        catch {
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
    getFallbackHtml(webview) {
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
    findAsset(dir, ext) {
        try {
            const files = fs.readdirSync(dir).filter((f) => f.endsWith(ext));
            if (files.length === 0)
                return null;
            const primary = files.find((f) => f === `webview${ext}`) ?? files[files.length - 1];
            return path.join(dir, primary);
        }
        catch {
            return null;
        }
    }
}
exports.ExplorerViewProvider = ExplorerViewProvider;
//# sourceMappingURL=explorerViewProvider.js.map