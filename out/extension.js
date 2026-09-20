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
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const child_process_1 = require("child_process");
const explorerViewProvider_1 = require("./explorerViewProvider");
const analyzerBridge_1 = require("./analyzerBridge");
const ollamaBridge_1 = require("./ollamaBridge");
const swiftFileDiscovery_1 = require("./swiftFileDiscovery");
const cacheManager_1 = require("./cacheManager");
const languageDetect_1 = require("./languageDetect");
const sotCache = __importStar(require("./sotCache"));
const sotLoader_1 = require("./sotLoader");
let activeProcess = null;
let lastAnalyzerBaseArgs = [];
let outputChannel;
let semanticCancellation = { cancelled: false };
/** Auto-detected languages for the current workspace (multi-lang OK). */
let workspaceLangs = [];
/** Primary language (strongest signal). */
let workspaceLang = null;
function bootstrapWorkspace(context, viewProvider, workspacePath) {
    try {
        const detected = (0, languageDetect_1.detectAllLanguages)(workspacePath);
        workspaceLangs = detected.map((d) => d.languageId);
        workspaceLang = workspaceLangs[0] ?? null;
        const label = detected.map((d) => d.languageId).join("+");
        outputChannel.appendLine(`[detect] ${path.basename(workspacePath)} → ${label} (${detected
            .map((d) => `${d.languageId}:${d.evidence}`)
            .join("; ")})`);
        vscode.window.setStatusBarMessage(`CodePrism: ${label}`, 8000);
        const mcpAutoEnable = vscode.workspace
            .getConfiguration("swiftPrism.mcp")
            .get("autoEnable", true);
        if (mcpAutoEnable) {
            // Omit CODE_PRISM_LANG when multi-lang so mcp-prism merges all caches.
            ensureMcpConfig(context.extensionPath, workspacePath, workspaceLangs.length === 1 ? workspaceLangs[0] : undefined);
        }
        const merged = [];
        const multi = workspaceLangs.length > 1;
        for (const lang of workspaceLangs) {
            const existing = sotCache.resolveExistingContext(workspacePath, lang);
            if (!existing)
                continue;
            try {
                const entries = (0, sotLoader_1.loadFlatEntriesFromSoT)(existing).map((e) => multi
                    ? {
                        ...e,
                        id: `${lang}::${e.id}`,
                        name: `[${lang}] ${e.name}`,
                        parents: (e.parents ?? []).map((p) => `${lang}::${p}`),
                        calls: (e.calls ?? []).map((c) => `${lang}::${c}`),
                    }
                    : e);
                merged.push(...entries);
                outputChannel.appendLine(`[sot] ${lang}: ${entries.length} from ${existing}`);
            }
            catch (err) {
                outputChannel.appendLine(`[sot] ${lang} load failed: ${err}`);
            }
        }
        if (merged.length > 0) {
            viewProvider.sendMappingData(merged);
            vscode.window.showInformationMessage(`CodePrism: ${label} · loaded ${merged.length} symbols from cache`);
        }
        else {
            outputChannel.appendLine(`[sot] No cache yet for [${label}]. Run “Analyze Project”.`);
        }
    }
    catch (err) {
        workspaceLang = null;
        workspaceLangs = [];
        const msg = err instanceof Error ? err.message : String(err);
        outputChannel.appendLine(`[detect] ${msg}`);
        vscode.window.showErrorMessage(`CodePrism: ${msg}`);
        viewProvider.sendError(msg);
    }
}
function ensureBinaryExists(extensionPath) {
    const binaryPath = (0, analyzerBridge_1.resolveAnalyzerBinary)(extensionPath);
    if (!fs.existsSync(binaryPath)) {
        throw new analyzerBridge_1.AnalyzerError("Binary not found. Please run ./run.sh in the SwiftPrism source folder first.\n\n" +
            "Or build manually:\n" +
            "  cd core && swift build -c release\n" +
            "  cp .build/release/swift-prism-analyzer ../extension/bin/");
    }
    try {
        fs.accessSync(binaryPath, fs.constants.X_OK);
    }
    catch {
        throw new analyzerBridge_1.AnalyzerError("Binary is not executable. Please run ./run.sh to rebuild for your current OS.\n\n" +
            "Binary path: " + binaryPath);
    }
    return binaryPath;
}
function logError(err, label) {
    const message = err instanceof analyzerBridge_1.AnalyzerError ? err.message : String(err);
    outputChannel.appendLine(`[${label}] ${message}`);
    if (err instanceof analyzerBridge_1.AnalyzerError && err.stderr) {
        outputChannel.appendLine(`[${label}] stderr:\n${err.stderr}`);
    }
    return message;
}
function activate(context) {
    outputChannel = vscode.window.createOutputChannel("CodePrism");
    context.subscriptions.push(outputChannel);
    const viewProvider = new explorerViewProvider_1.ExplorerViewProvider(context.extensionUri);
    const cache = new cacheManager_1.CacheManager(context.globalStorageUri);
    console.log("CodePrism activated — auto-detect language, SoT from system cache");
    const workspaceRoot = (0, swiftFileDiscovery_1.getWorkspaceRoot)();
    if (workspaceRoot) {
        bootstrapWorkspace(context, viewProvider, workspaceRoot.fsPath);
    }
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const root = (0, swiftFileDiscovery_1.getWorkspaceRoot)();
        if (root)
            bootstrapWorkspace(context, viewProvider, root.fsPath);
    }));
    // ── Fire-and-forget semantic context enrichment ──
    // Takes FlatMapEntry[] directly (already available from directScan or quick analysis).
    // Runs fully async: the graph is interactive the whole time.
    // Each node streams its context to the webview as it finishes.
    function startBackgroundEnrichment(entries, workspacePath) {
        const currentCancellation = semanticCancellation;
        const stealthDir = path.join(workspacePath, ".swiftprism");
        // Tell webview which nodes are pending — all enrichable flavors including targets
        const eligibleFlavors = new Set(["function", "class", "struct", "enum", "actor", "protocol", "macro", "entry_point", "target", "variable", "initializer"]);
        const pendingIds = entries.filter(e => eligibleFlavors.has(e.flavor)).map(e => e.id);
        if (pendingIds.length === 0)
            return;
        viewProvider.sendPendingContextIds(pendingIds);
        viewProvider.sendProgress({ phase: "semantic_context", processed: 0, total: pendingIds.length });
        (0, ollamaBridge_1.enrichWithSemanticContext)(entries, stealthDir, {
            onProgress: (progress) => {
                if (currentCancellation.cancelled)
                    return;
                viewProvider.sendSemanticContextProgress(progress);
                viewProvider.sendProgress({
                    phase: "semantic_context",
                    processed: progress.completed,
                    total: progress.total,
                });
            },
            onNodeEnriched: (nodeId, ctx) => {
                if (currentCancellation.cancelled)
                    return;
                viewProvider.sendNodeContextUpdate(nodeId, ctx);
            },
        }, currentCancellation).then((enrichResult) => {
            if (currentCancellation.cancelled)
                return;
            // Persist enriched graph for MCP server
            const graphPath = (0, ollamaBridge_1.persistEnrichedGraph)(entries, workspacePath);
            if (graphPath)
                outputChannel.appendLine(`[semantic] Enriched graph saved → ${graphPath}`);
            // Final webview update
            viewProvider.sendPendingContextIds([]);
            viewProvider.sendMappingData(entries);
            viewProvider.sendSemanticContextComplete({
                enrichedCount: enrichResult.enrichedCount,
                cachedCount: enrichResult.cachedCount,
                llmUsed: enrichResult.llmUsed,
            });
            viewProvider.sendProgress({ phase: "complete", processed: 1, total: 1 });
            outputChannel.appendLine(`[semantic] Context enrichment: ${enrichResult.enrichedCount} generated, ` +
                `${enrichResult.cachedCount} cached, LLM: ${enrichResult.llmUsed}`);
        }).catch((err) => {
            outputChannel.appendLine(`[semantic] Context enrichment failed (non-fatal): ${err}`);
            viewProvider.sendPendingContextIds([]);
            viewProvider.sendProgress({ phase: "complete", processed: 1, total: 1 });
        });
    }
    const runQuickAnalysis = async () => {
        const workspaceRoot = (0, swiftFileDiscovery_1.getWorkspaceRoot)();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage("CodePrism: Open a workspace folder first.");
            return;
        }
        if (workspaceLangs.length === 0) {
            try {
                const detected = (0, languageDetect_1.detectAllLanguages)(workspaceRoot.fsPath);
                workspaceLangs = detected.map((d) => d.languageId);
                workspaceLang = workspaceLangs[0] ?? null;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                vscode.window.showErrorMessage(`CodePrism: ${msg}`);
                viewProvider.sendError(msg);
                return;
            }
        }
        semanticCancellation.cancelled = true;
        semanticCancellation = { cancelled: false };
        viewProvider.sendProgress({ phase: "scanning", processed: 0, total: 0 });
        try {
            const workspacePath = workspaceRoot.fsPath;
            const multi = workspaceLangs.length > 1;
            const merged = [];
            for (const lang of workspaceLangs) {
                let entries;
                if (lang === "swift") {
                    const binaryPath = ensureBinaryExists(context.extensionPath);
                    const outPath = sotCache.contextJsonPath(lang, workspacePath);
                    sotCache.ensureCacheDir(lang, workspacePath);
                    entries = await (0, analyzerBridge_1.runSwiftAnalyzerToPath)(binaryPath, workspacePath, outPath);
                    sotCache.writeMeta(lang, workspacePath, { symbolCount: entries.length });
                }
                else {
                    entries = await runGenericBackendToCache(lang, workspacePath);
                }
                if (multi) {
                    entries = entries.map((e) => ({
                        ...e,
                        id: `${lang}::${e.id}`,
                        name: `[${lang}] ${e.name}`,
                        parents: (e.parents ?? []).map((p) => `${lang}::${p}`),
                        calls: (e.calls ?? []).map((c) => `${lang}::${c}`),
                    }));
                }
                merged.push(...entries);
            }
            viewProvider.sendMappingData(merged);
            viewProvider.sendProgress({ phase: "complete", processed: 1, total: 1 });
            vscode.window.showInformationMessage(`CodePrism (${workspaceLangs.join("+")}): Mapped ${merged.length} symbols → system cache.`);
            if (workspaceLangs.includes("swift")) {
                const swiftEntries = merged.filter((e) => !multi || e.id.startsWith("swift::"));
                startBackgroundEnrichment(swiftEntries, workspacePath);
            }
        }
        catch (err) {
            const message = logError(err, "analysis");
            viewProvider.sendError(message);
            vscode.window.showErrorMessage(`CodePrism: ${message}`);
        }
    };
    const runFullAnalysis = async () => {
        if (activeProcess) {
            activeProcess.kill();
            activeProcess = null;
        }
        // Cancel any in-flight semantic context generation
        semanticCancellation.cancelled = true;
        semanticCancellation = { cancelled: false };
        const workspaceRoot = (0, swiftFileDiscovery_1.getWorkspaceRoot)();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage("SwiftPrism: Open a workspace folder first.");
            return;
        }
        viewProvider.sendProgress({ phase: "scanning", processed: 0, total: 0 });
        try {
            const binaryPath = ensureBinaryExists(context.extensionPath);
            const swiftFiles = await (0, swiftFileDiscovery_1.findSwiftFiles)(workspaceRoot);
            if (swiftFiles.length === 0) {
                viewProvider.sendError("No .swift files found in workspace.");
                return;
            }
            const workspacePath = workspaceRoot.fsPath;
            const baseArgs = ["--workspace", workspacePath, "--scan-targets", "--public-only-external", "--collapse-modules", ...swiftFiles];
            lastAnalyzerBaseArgs = baseArgs;
            const { promise: summaryPromise, process: summaryProcess } = (0, analyzerBridge_1.runSummaryAnalysis)(binaryPath, baseArgs, {
                onProgress: (progress) => viewProvider.sendProgress(progress),
                onWarning: (message) => vscode.window.showWarningMessage(`SwiftPrism: ${message}`),
            });
            activeProcess = summaryProcess;
            const summaryResult = await summaryPromise;
            activeProcess = null;
            viewProvider.sendResult(summaryResult);
            vscode.window.showInformationMessage(`SwiftPrism: ${summaryResult.nodes.length} top-level symbols loaded. Click a type to expand members.`);
            const { promise: fullPromise, process: fullProcess } = (0, analyzerBridge_1.runAnalyzer)(binaryPath, baseArgs, {
                onProgress: () => { },
                onWarning: () => { },
            });
            activeProcess = fullProcess;
            const fullResult = await fullPromise;
            activeProcess = null;
            const contextPath = cache.resolveContextPath(workspacePath);
            generateContextFile(binaryPath, workspacePath, swiftFiles, contextPath);
            viewProvider.sendResult(fullResult);
            const resourceCount = fullResult.resources?.length ?? 0;
            const resourceMsg = resourceCount > 0 ? `, ${resourceCount} resources` : "";
            vscode.window.showInformationMessage(`SwiftPrism: Full analysis complete — ${fullResult.nodes.length} symbols, ${fullResult.links.length} links${resourceMsg}.`);
            // ── Background Semantic Context Enrichment ──
            // Run a quick directScan to get FlatMapEntry[] (the format ollamaBridge needs),
            // then enrich each node asynchronously. The 3D graph stays interactive.
            const mappingPath = cache.resolveMappingPath(workspacePath);
            (0, analyzerBridge_1.runSwiftAnalyzerToPath)(binaryPath, workspacePath, mappingPath)
                .then((entries) => {
                startBackgroundEnrichment(entries, workspacePath);
            })
                .catch((err) => {
                outputChannel.appendLine(`[semantic] DirectScan for enrichment failed (non-fatal): ${err}`);
            });
        }
        catch (err) {
            activeProcess = null;
            const message = logError(err, "analysis");
            viewProvider.sendError(message);
            vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
        }
    };
    const analyzeAndShowJson = async () => {
        const workspaceRoot = (0, swiftFileDiscovery_1.getWorkspaceRoot)();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage("SwiftPrism: Open a workspace folder first.");
            return;
        }
        let binaryPath;
        try {
            binaryPath = ensureBinaryExists(context.extensionPath);
        }
        catch (err) {
            vscode.window.showWarningMessage("SwiftPrism: Binary not found. Please run ./run.sh in the SwiftPrism source folder first.");
            return;
        }
        const workspacePath = workspaceRoot.fsPath;
        const outputPath = cache.resolveAnalysisPath(workspacePath);
        viewProvider.sendProgress({ phase: "scanning", processed: 0, total: 0 });
        try {
            const jsonContent = await spawnAnalyzerToFile(binaryPath, workspacePath, outputPath);
            try {
                const entries = JSON.parse(jsonContent);
                viewProvider.sendMappingData(entries);
            }
            catch {
                /* non-critical — JSON tab still opens */
            }
            viewProvider.sendProgress({ phase: "complete", processed: 1, total: 1 });
            const doc = await vscode.workspace.openTextDocument({
                content: jsonContent,
                language: "json",
            });
            await vscode.window.showTextDocument(doc, { preview: false });
        }
        catch (err) {
            viewProvider.sendProgress({ phase: "error", processed: 0, total: 0 });
            const message = logError(err, "analyzeAndShowJson");
            viewProvider.sendError(message);
            vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
        }
    };
    const showRawJson = async () => {
        const workspaceRoot = (0, swiftFileDiscovery_1.getWorkspaceRoot)();
        const outputPath = workspaceRoot ? cache.resolveAnalysisPath(workspaceRoot.fsPath) : "";
        if (fs.existsSync(outputPath)) {
            try {
                const jsonContent = fs.readFileSync(outputPath, "utf-8");
                JSON.parse(jsonContent);
                const doc = await vscode.workspace.openTextDocument({
                    content: jsonContent,
                    language: "json",
                });
                await vscode.window.showTextDocument(doc, { preview: false });
                return;
            }
            catch {
                /* stale or corrupt — re-analyze */
            }
        }
        await analyzeAndShowJson();
    };
    const handleCopyContext = async (nodeId) => {
        const workspaceRoot = (0, swiftFileDiscovery_1.getWorkspaceRoot)();
        if (!workspaceRoot)
            return;
        try {
            const binaryPath = ensureBinaryExists(context.extensionPath);
            const swiftFiles = await (0, swiftFileDiscovery_1.findSwiftFiles)(workspaceRoot);
            const workspacePath = workspaceRoot.fsPath;
            const dependents = await (0, analyzerBridge_1.runFindDependents)(binaryPath, workspacePath, swiftFiles, nodeId);
            const prompt = buildContextPrompt(nodeId, dependents);
            await vscode.env.clipboard.writeText(prompt);
            const tokenEstimate = Math.ceil(prompt.length / 4);
            viewProvider.sendContextCopied(tokenEstimate);
            vscode.window.showInformationMessage(`SwiftPrism: Context copied (~${tokenEstimate} tokens).`);
        }
        catch (err) {
            const message = logError(err, "copyContext");
            vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
        }
    };
    const handleOpenFile = async (data) => {
        try {
            const uri = vscode.Uri.file(data.file);
            const position = new vscode.Position(Math.max(0, data.line - 1), Math.max(0, data.col - 1));
            const doc = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(doc, { preview: true });
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
        catch {
            vscode.window.showErrorMessage(`SwiftPrism: Could not open ${data.file}`);
        }
    };
    const handleRequestRawJson = () => {
        vscode.commands.executeCommand("swiftPrism.analyzeAndShowJson");
    };
    const handleRequestMembers = async (nodeId) => {
        if (lastAnalyzerBaseArgs.length === 0)
            return;
        try {
            const binaryPath = ensureBinaryExists(context.extensionPath);
            const memberResult = await (0, analyzerBridge_1.runMembersOf)(binaryPath, nodeId, lastAnalyzerBaseArgs);
            viewProvider.sendMemberDetail(nodeId, memberResult);
        }
        catch (err) {
            const message = logError(err, "requestMembers");
            vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
        }
    };
    const handleFilePreview = async (nodeId, filePath) => {
        if (!filePath || !fs.existsSync(filePath)) {
            viewProvider.sendFilePreview({ nodeId, previewType: "none", data: "", fileName: "" });
            return;
        }
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const imageExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg", ".pdf"]);
        const textExts = new Set([".json", ".plist", ".strings", ".stringsdict", ".xml", ".yaml", ".yml", ".md", ".txt"]);
        if (imageExts.has(ext)) {
            try {
                const data = fs.readFileSync(filePath);
                const mime = ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : ext === ".webp" ? "image/webp" : "image/jpeg";
                const base64 = `data:${mime};base64,${data.toString("base64")}`;
                viewProvider.sendFilePreview({ nodeId, previewType: "image", data: base64, fileName });
            }
            catch {
                viewProvider.sendFilePreview({ nodeId, previewType: "none", data: "", fileName });
            }
            return;
        }
        if (textExts.has(ext)) {
            try {
                const content = fs.readFileSync(filePath, "utf-8");
                const lines = content.split("\n").slice(0, 20).join("\n");
                viewProvider.sendFilePreview({ nodeId, previewType: "text", data: lines, fileName });
            }
            catch {
                viewProvider.sendFilePreview({ nodeId, previewType: "none", data: "", fileName });
            }
            return;
        }
        viewProvider.sendFilePreview({ nodeId, previewType: "none", data: "", fileName });
    };
    viewProvider.setAnalyzeHandler(runFullAnalysis);
    viewProvider.setCopyContextHandler(handleCopyContext);
    viewProvider.setOpenFileHandler(handleOpenFile);
    viewProvider.setRequestRawJsonHandler(handleRequestRawJson);
    viewProvider.setRequestMembersHandler(handleRequestMembers);
    viewProvider.setRequestFilePreviewHandler(handleFilePreview);
    viewProvider.setWebviewErrorHandler((message) => {
        outputChannel.appendLine(`[webview error] ${message}`);
    });
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(explorerViewProvider_1.ExplorerViewProvider.viewType, viewProvider));
    context.subscriptions.push(vscode.commands.registerCommand("swiftPrism.analyzeProject", runFullAnalysis));
    context.subscriptions.push(vscode.commands.registerCommand("swiftPrism.refresh", runQuickAnalysis));
    context.subscriptions.push(vscode.commands.registerCommand("swiftPrism.showRawJson", showRawJson));
    context.subscriptions.push(vscode.commands.registerCommand("swiftPrism.analyzeAndShowJson", analyzeAndShowJson));
    context.subscriptions.push(vscode.commands.registerCommand("swiftPrism.clearCache", async () => {
        const count = cache.clearAll();
        vscode.window.showInformationMessage(`SwiftPrism: Cleared ${count} cached files.`);
    }));
    context.subscriptions.push(vscode.commands.registerCommand("swiftPrism.configureMCP", () => {
        configureMCPForDesktop(context.extensionPath);
    }));
    context.subscriptions.push({
        dispose: () => {
            activeProcess?.kill();
            activeProcess = null;
        },
    });
}
function spawnAnalyzerToFile(binaryPath, projectPath, outputPath) {
    return new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(binaryPath, [projectPath, outputPath], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (err) => {
            const code = err.code;
            if (code === "ENOENT") {
                reject(new analyzerBridge_1.AnalyzerError("Binary not found. Please run ./run.sh in the SwiftPrism source folder first.", stderr));
            }
            else if (code === "ENOEXEC" || code === "EACCES") {
                reject(new analyzerBridge_1.AnalyzerError("Binary is not executable on this OS. Please run ./run.sh to rebuild for your current platform (" +
                    process.platform + " " + process.arch + ").", stderr));
            }
            else {
                reject(new analyzerBridge_1.AnalyzerError(`Failed to launch analyzer: ${err.message}`, stderr));
            }
        });
        child.on("close", (code) => {
            if (code !== 0) {
                let errorMsg = `Analyzer exited with code ${code}`;
                for (const line of stderr.split("\n").reverse()) {
                    try {
                        const msg = JSON.parse(line.trim());
                        if (msg._error) {
                            errorMsg = String(msg._error);
                            break;
                        }
                    }
                    catch { /* skip */ }
                }
                reject(new analyzerBridge_1.AnalyzerError(errorMsg));
                return;
            }
            try {
                const content = fs.readFileSync(outputPath, "utf-8");
                resolve(content);
            }
            catch {
                reject(new analyzerBridge_1.AnalyzerError(`Analysis completed but output file not found: ${outputPath}`));
            }
        });
    });
}
function generateContextFile(binaryPath, workspacePath, swiftFiles, outputPath) {
    (0, analyzerBridge_1.runContextGenerator)(binaryPath, workspacePath, swiftFiles, outputPath).catch(() => { });
}
function buildContextPrompt(nodeId, dependents) {
    const lines = [];
    lines.push(`# SwiftPrism Context: ${nodeId}`);
    lines.push("");
    if (dependents.files?.length) {
        lines.push("## Related Files");
        for (const f of dependents.files)
            lines.push(`- ${f}`);
        lines.push("");
    }
    if (dependents.direct?.length) {
        lines.push("## Direct Dependencies");
        for (const d of dependents.direct)
            lines.push(`- ${d}`);
        lines.push("");
    }
    if (dependents.transitive?.length) {
        lines.push("## Transitive Dependencies (depth 3)");
        for (const t of dependents.transitive)
            lines.push(`- ${t}`);
        lines.push("");
    }
    if (dependents.resources?.length) {
        lines.push("## Resources");
        for (const r of dependents.resources)
            lines.push(`- ${r}`);
        lines.push("");
    }
    lines.push("---");
    lines.push(`> Generated by SwiftPrism. Query: \`swift-prism-analyzer --find-dependents-of "${nodeId}"\``);
    return lines.join("\n");
}
// ═══════════════════════════════════════════════════════════════════════════════
// MCP SERVER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════
function resolveMcpPrismServer() {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const candidates = [
        path.join(home, "Documents", "Code", "mcp-prism", "dist", "server.js"),
        path.resolve(__dirname, "..", "..", "mcp-prism", "dist", "server.js"),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
}
/**
 * Point mcp-prism at this workspace (PRISM_CWD). SoT is read from system cache.
 */
function ensureMcpConfig(extensionPath, workspaceRoot, lang) {
    void extensionPath;
    const mcpJsonPath = path.join(workspaceRoot, ".mcp.json");
    const serverPath = resolveMcpPrismServer();
    if (!serverPath) {
        outputChannel.appendLine("[mcp] mcp-prism dist not found — skip .mcp.json (npm run build in ~/Documents/Code/mcp-prism)");
        return;
    }
    const env = { PRISM_CWD: workspaceRoot };
    if (lang)
        env.CODE_PRISM_LANG = lang;
    const mcpConfig = {
        mcpServers: {
            "mcp-prism": {
                command: "node",
                args: [serverPath],
                env,
            },
        },
    };
    // Read existing .mcp.json and merge (preserve other servers)
    let existing = {};
    if (fs.existsSync(mcpJsonPath)) {
        try {
            existing = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
        }
        catch { /* corrupt — overwrite */ }
    }
    const merged = {
        ...existing,
        mcpServers: {
            ...(existing.mcpServers ?? {}),
            ...mcpConfig.mcpServers,
        },
    };
    // Only write if changed
    const newContent = JSON.stringify(merged, null, 2) + "\n";
    const oldContent = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, "utf-8") : "";
    if (newContent !== oldContent) {
        fs.writeFileSync(mcpJsonPath, newContent);
        outputChannel.appendLine(`[mcp] Wrote .mcp.json → ${mcpJsonPath}`);
    }
}
/**
 * Generate a claude_desktop_config.json snippet and copy it to clipboard.
 */
async function configureMCPForDesktop(extensionPath) {
    void extensionPath;
    const workspaceRoot = (0, swiftFileDiscovery_1.getWorkspaceRoot)();
    if (!workspaceRoot) {
        vscode.window.showErrorMessage("CodePrism: Open a workspace folder first.");
        return;
    }
    const serverPath = resolveMcpPrismServer();
    if (!serverPath) {
        vscode.window.showErrorMessage("CodePrism: mcp-prism dist not found. Build ~/Documents/Code/mcp-prism first.");
        return;
    }
    const env = { PRISM_CWD: workspaceRoot.fsPath };
    if (workspaceLang)
        env.CODE_PRISM_LANG = workspaceLang;
    const config = {
        mcpServers: {
            "mcp-prism": {
                command: "node",
                args: [serverPath],
                env,
            },
        },
    };
    const snippet = JSON.stringify(config, null, 2);
    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage("CodePrism: MCP config copied to clipboard (points at workspace → system cache).");
}
/** Run js/marlin/kotlin/rust/go backend → system cache → FlatMapEntry[]. */
async function runGenericBackendToCache(lang, workspacePath) {
    const home = process.env.HOME || "";
    const repo = lang === "js" ? "js-prism" : lang === "objc" ? "objective-c-prism" : `${lang}-prism`;
    const binName = lang === "objc" ? "objective-c-prism" : `${lang === "js" ? "js" : lang}-prism`;
    const binary = path.join(home, "Documents", "Code", "code-prism", "backends", repo, "bin", binName);
    if (!fs.existsSync(binary)) {
        throw new analyzerBridge_1.AnalyzerError(`Backend not found: ${binary}. Clone code-prism/backends/${repo}.`);
    }
    const outPath = sotCache.contextJsonPath(lang, workspacePath);
    sotCache.ensureCacheDir(lang, workspacePath);
    await new Promise((resolve, reject) => {
        const child = (0, child_process_1.spawn)(binary, ["--root", workspacePath, "--out", outPath, "--lang", lang], {
            env: { ...process.env, CODE_PRISM_LANG: lang },
        });
        let err = "";
        child.stderr.on("data", (d) => { err += String(d); });
        child.on("close", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new analyzerBridge_1.AnalyzerError(err || `backend exit ${code}`));
        });
    });
    sotCache.writeMeta(lang, workspacePath);
    return (0, sotLoader_1.loadFlatEntriesFromSoT)(outPath);
}
function deactivate() {
    activeProcess?.kill();
    activeProcess = null;
}
//# sourceMappingURL=extension.js.map