import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { spawn, type ChildProcess } from "child_process";
import { ExplorerViewProvider } from "./explorerViewProvider";
import {
  resolveAnalyzerBinary,
  runSwiftAnalyzerToPath,
  runAnalyzer,
  runSummaryAnalysis,
  runMembersOf,
  runContextGenerator,
  runFindDependents,
  AnalyzerError,
  type FlatMapEntry,
} from "./analyzerBridge";
import { enrichWithSemanticContext, persistEnrichedGraph } from "./ollamaBridge";
import { findSwiftFiles, getWorkspaceRoot } from "./swiftFileDiscovery";
import { CacheManager } from "./cacheManager";

let activeProcess: ChildProcess | null = null;
let lastAnalyzerBaseArgs: string[] = [];
let outputChannel: vscode.OutputChannel;
let semanticCancellation = { cancelled: false };

function ensureBinaryExists(extensionPath: string): string {
  const binaryPath = resolveAnalyzerBinary(extensionPath);

  if (!fs.existsSync(binaryPath)) {
    throw new AnalyzerError(
      "Binary not found. Please run ./run.sh in the SwiftPrism source folder first.\n\n" +
      "Or build manually:\n" +
      "  cd core && swift build -c release\n" +
      "  cp .build/release/swift-prism-analyzer ../extension/bin/"
    );
  }

  try {
    fs.accessSync(binaryPath, fs.constants.X_OK);
  } catch {
    throw new AnalyzerError(
      "Binary is not executable. Please run ./run.sh to rebuild for your current OS.\n\n" +
      "Binary path: " + binaryPath
    );
  }

  return binaryPath;
}

function logError(err: unknown, label: string): string {
  const message = err instanceof AnalyzerError ? err.message : String(err);
  outputChannel.appendLine(`[${label}] ${message}`);
  if (err instanceof AnalyzerError && err.stderr) {
    outputChannel.appendLine(`[${label}] stderr:\n${err.stderr}`);
  }
  return message;
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("SwiftPrism");
  context.subscriptions.push(outputChannel);

  const viewProvider = new ExplorerViewProvider(context.extensionUri);
  const cache = new CacheManager(context.globalStorageUri);

  // v4.0 flat-graph schema: purge all prior caches on every activation
  const cleared = cache.clearAll();
  if (cleared > 0) {
    outputChannel.appendLine(`[v4.0] Cleared ${cleared} cached file(s) from globalStorageUri`);
  }
  context.workspaceState.keys().forEach((key) => context.workspaceState.update(key, undefined));
  context.globalState.keys().forEach((key) => context.globalState.update(key, undefined));
  console.log("CORE: Hierarchical Analyzer Activated — v4.0 flat-graph");

  const workspaceRoot = getWorkspaceRoot();
  if (workspaceRoot) {
    const cleaned = cache.cleanupWorkspaceArtifacts(workspaceRoot.fsPath);
    if (cleaned > 0) {
      outputChannel.appendLine(`[cleanup] Removed ${cleaned} old artifact(s) from workspace root`);
    }
  }

  // ── MCP Auto-Configuration ──
  // Write .mcp.json to workspace root so Claude Code discovers the server automatically.
  const mcpAutoEnable = vscode.workspace.getConfiguration("swiftPrism.mcp").get<boolean>("autoEnable", true);
  if (mcpAutoEnable && workspaceRoot) {
    ensureMcpConfig(context.extensionPath, workspaceRoot.fsPath);
  }

  // ── Fire-and-forget semantic context enrichment ──
  // Takes FlatMapEntry[] directly (already available from directScan or quick analysis).
  // Runs fully async: the graph is interactive the whole time.
  // Each node streams its context to the webview as it finishes.
  function startBackgroundEnrichment(entries: FlatMapEntry[], workspacePath: string) {
    const currentCancellation = semanticCancellation;
    const stealthDir = path.join(workspacePath, ".swiftprism");

    // Tell webview which nodes are pending — all enrichable flavors including targets
    const eligibleFlavors = new Set(["function", "class", "struct", "enum", "actor", "protocol", "macro", "entry_point", "target", "variable", "initializer"]);
    const pendingIds = entries.filter(e => eligibleFlavors.has(e.flavor)).map(e => e.id);
    if (pendingIds.length === 0) return;

    viewProvider.sendPendingContextIds(pendingIds);
    viewProvider.sendProgress({ phase: "semantic_context", processed: 0, total: pendingIds.length });

    enrichWithSemanticContext(
      entries,
      stealthDir,
      {
        onProgress: (progress) => {
          if (currentCancellation.cancelled) return;
          viewProvider.sendSemanticContextProgress(progress);
          viewProvider.sendProgress({
            phase: "semantic_context",
            processed: progress.completed,
            total: progress.total,
          });
        },
        onNodeEnriched: (nodeId, ctx) => {
          if (currentCancellation.cancelled) return;
          viewProvider.sendNodeContextUpdate(nodeId, ctx);
        },
      },
      currentCancellation
    ).then((enrichResult) => {
      if (currentCancellation.cancelled) return;

      // Persist enriched graph for MCP server
      const graphPath = persistEnrichedGraph(entries, workspacePath);
      if (graphPath) outputChannel.appendLine(`[semantic] Enriched graph saved → ${graphPath}`);

      // Final webview update
      viewProvider.sendPendingContextIds([]);
      viewProvider.sendMappingData(entries);
      viewProvider.sendSemanticContextComplete({
        enrichedCount: enrichResult.enrichedCount,
        cachedCount: enrichResult.cachedCount,
        llmUsed: enrichResult.llmUsed,
      });
      viewProvider.sendProgress({ phase: "complete", processed: 1, total: 1 });

      outputChannel.appendLine(
        `[semantic] Context enrichment: ${enrichResult.enrichedCount} generated, ` +
        `${enrichResult.cachedCount} cached, LLM: ${enrichResult.llmUsed}`
      );
    }).catch((err) => {
      outputChannel.appendLine(`[semantic] Context enrichment failed (non-fatal): ${err}`);
      viewProvider.sendPendingContextIds([]);
      viewProvider.sendProgress({ phase: "complete", processed: 1, total: 1 });
    });
  }

  const runQuickAnalysis = async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("SwiftPrism: Open a workspace folder first.");
      return;
    }

    // Cancel prior enrichment
    semanticCancellation.cancelled = true;
    semanticCancellation = { cancelled: false };

    viewProvider.sendProgress({ phase: "scanning", processed: 0, total: 0 });

    try {
      const binaryPath = ensureBinaryExists(context.extensionPath);
      const mappingPath = cache.resolveMappingPath(workspaceRoot.fsPath);
      const entries = await runSwiftAnalyzerToPath(binaryPath, workspaceRoot.fsPath, mappingPath);

      viewProvider.sendMappingData(entries);
      viewProvider.sendProgress({ phase: "complete", processed: 1, total: 1 });
      vscode.window.showInformationMessage(
        `SwiftPrism: Mapped ${entries.length} symbols.`
      );

      // Kick off async enrichment — UI never freezes
      startBackgroundEnrichment(entries, workspaceRoot.fsPath);
    } catch (err) {
      const message = logError(err, "analysis");
      viewProvider.sendError(message);
      vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
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

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("SwiftPrism: Open a workspace folder first.");
      return;
    }

    viewProvider.sendProgress({ phase: "scanning", processed: 0, total: 0 });

    try {
      const binaryPath = ensureBinaryExists(context.extensionPath);
      const swiftFiles = await findSwiftFiles(workspaceRoot);

      if (swiftFiles.length === 0) {
        viewProvider.sendError("No .swift files found in workspace.");
        return;
      }

      const workspacePath = workspaceRoot.fsPath;
      const baseArgs = ["--workspace", workspacePath, "--scan-targets", "--public-only-external", "--collapse-modules", ...swiftFiles];
      lastAnalyzerBaseArgs = baseArgs;

      const { promise: summaryPromise, process: summaryProcess } = runSummaryAnalysis(
        binaryPath,
        baseArgs,
        {
          onProgress: (progress) => viewProvider.sendProgress(progress),
          onWarning: (message) => vscode.window.showWarningMessage(`SwiftPrism: ${message}`),
        }
      );

      activeProcess = summaryProcess;
      const summaryResult = await summaryPromise;
      activeProcess = null;

      viewProvider.sendResult(summaryResult);
      vscode.window.showInformationMessage(
        `SwiftPrism: ${summaryResult.nodes.length} top-level symbols loaded. Click a type to expand members.`
      );

      const { promise: fullPromise, process: fullProcess } = runAnalyzer(
        binaryPath,
        baseArgs,
        {
          onProgress: () => {},
          onWarning: () => {},
        }
      );

      activeProcess = fullProcess;
      const fullResult = await fullPromise;
      activeProcess = null;

      const contextPath = cache.resolveContextPath(workspacePath);
      generateContextFile(binaryPath, workspacePath, swiftFiles, contextPath);

      viewProvider.sendResult(fullResult);

      const resourceCount = fullResult.resources?.length ?? 0;
      const resourceMsg = resourceCount > 0 ? `, ${resourceCount} resources` : "";
      vscode.window.showInformationMessage(
        `SwiftPrism: Full analysis complete — ${fullResult.nodes.length} symbols, ${fullResult.links.length} links${resourceMsg}.`
      );

      // ── Background Semantic Context Enrichment ──
      // Run a quick directScan to get FlatMapEntry[] (the format ollamaBridge needs),
      // then enrich each node asynchronously. The 3D graph stays interactive.
      const mappingPath = cache.resolveMappingPath(workspacePath);
      runSwiftAnalyzerToPath(binaryPath, workspacePath, mappingPath)
        .then((entries) => {
          startBackgroundEnrichment(entries, workspacePath);
        })
        .catch((err) => {
          outputChannel.appendLine(`[semantic] DirectScan for enrichment failed (non-fatal): ${err}`);
        });
    } catch (err) {
      activeProcess = null;
      const message = logError(err, "analysis");
      viewProvider.sendError(message);
      vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
    }
  };

  const analyzeAndShowJson = async () => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      vscode.window.showErrorMessage("SwiftPrism: Open a workspace folder first.");
      return;
    }

    let binaryPath: string;
    try {
      binaryPath = ensureBinaryExists(context.extensionPath);
    } catch (err) {
      vscode.window.showWarningMessage(
        "SwiftPrism: Binary not found. Please run ./run.sh in the SwiftPrism source folder first."
      );
      return;
    }

    const workspacePath = workspaceRoot.fsPath;
    const outputPath = cache.resolveAnalysisPath(workspacePath);

    viewProvider.sendProgress({ phase: "scanning", processed: 0, total: 0 });

    try {
      const jsonContent = await spawnAnalyzerToFile(binaryPath, workspacePath, outputPath);

      try {
        const entries: FlatMapEntry[] = JSON.parse(jsonContent);
        viewProvider.sendMappingData(entries);
      } catch {
        /* non-critical — JSON tab still opens */
      }

      viewProvider.sendProgress({ phase: "complete", processed: 1, total: 1 });

      const doc = await vscode.workspace.openTextDocument({
        content: jsonContent,
        language: "json",
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      viewProvider.sendProgress({ phase: "error", processed: 0, total: 0 });
      const message = logError(err, "analyzeAndShowJson");
      viewProvider.sendError(message);
      vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
    }
  };

  const showRawJson = async () => {
    const workspaceRoot = getWorkspaceRoot();
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
      } catch {
        /* stale or corrupt — re-analyze */
      }
    }

    await analyzeAndShowJson();
  };

  const handleCopyContext = async (nodeId: string) => {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) return;

    try {
      const binaryPath = ensureBinaryExists(context.extensionPath);
      const swiftFiles = await findSwiftFiles(workspaceRoot);
      const workspacePath = workspaceRoot.fsPath;
      const dependents = await runFindDependents(binaryPath, workspacePath, swiftFiles, nodeId);
      const prompt = buildContextPrompt(nodeId, dependents);
      await vscode.env.clipboard.writeText(prompt);
      const tokenEstimate = Math.ceil(prompt.length / 4);
      viewProvider.sendContextCopied(tokenEstimate);
      vscode.window.showInformationMessage(`SwiftPrism: Context copied (~${tokenEstimate} tokens).`);
    } catch (err) {
      const message = logError(err, "copyContext");
      vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
    }
  };

  const handleOpenFile = async (data: { file: string; line: number; col: number }) => {
    try {
      const uri = vscode.Uri.file(data.file);
      const position = new vscode.Position(Math.max(0, data.line - 1), Math.max(0, data.col - 1));
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
      );
    } catch {
      vscode.window.showErrorMessage(`SwiftPrism: Could not open ${data.file}`);
    }
  };

  const handleRequestRawJson = () => {
    vscode.commands.executeCommand("swiftPrism.analyzeAndShowJson");
  };

  const handleRequestMembers = async (nodeId: string) => {
    if (lastAnalyzerBaseArgs.length === 0) return;
    try {
      const binaryPath = ensureBinaryExists(context.extensionPath);
      const memberResult = await runMembersOf(binaryPath, nodeId, lastAnalyzerBaseArgs);
      viewProvider.sendMemberDetail(nodeId, memberResult);
    } catch (err) {
      const message = logError(err, "requestMembers");
      vscode.window.showErrorMessage(`SwiftPrism: ${message}`);
    }
  };

  const handleFilePreview = async (nodeId: string, filePath: string) => {
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
      } catch {
        viewProvider.sendFilePreview({ nodeId, previewType: "none", data: "", fileName });
      }
      return;
    }

    if (textExts.has(ext)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").slice(0, 20).join("\n");
        viewProvider.sendFilePreview({ nodeId, previewType: "text", data: lines, fileName });
      } catch {
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

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ExplorerViewProvider.viewType, viewProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("swiftPrism.analyzeProject", runFullAnalysis)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("swiftPrism.refresh", runQuickAnalysis)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("swiftPrism.showRawJson", showRawJson)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("swiftPrism.analyzeAndShowJson", analyzeAndShowJson)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("swiftPrism.clearCache", async () => {
      const count = cache.clearAll();
      vscode.window.showInformationMessage(`SwiftPrism: Cleared ${count} cached files.`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("swiftPrism.configureMCP", () => {
      configureMCPForDesktop(context.extensionPath);
    })
  );

  context.subscriptions.push({
    dispose: () => {
      activeProcess?.kill();
      activeProcess = null;
    },
  });
}

function spawnAnalyzerToFile(
  binaryPath: string,
  projectPath: string,
  outputPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [projectPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new AnalyzerError(
          "Binary not found. Please run ./run.sh in the SwiftPrism source folder first.",
          stderr
        ));
      } else if (code === "ENOEXEC" || code === "EACCES") {
        reject(new AnalyzerError(
          "Binary is not executable on this OS. Please run ./run.sh to rebuild for your current platform (" +
          process.platform + " " + process.arch + ").",
          stderr
        ));
      } else {
        reject(new AnalyzerError(`Failed to launch analyzer: ${err.message}`, stderr));
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        let errorMsg = `Analyzer exited with code ${code}`;
        for (const line of stderr.split("\n").reverse()) {
          try {
            const msg = JSON.parse(line.trim());
            if (msg._error) { errorMsg = String(msg._error); break; }
          } catch { /* skip */ }
        }
        reject(new AnalyzerError(errorMsg));
        return;
      }

      try {
        const content = fs.readFileSync(outputPath, "utf-8");
        resolve(content);
      } catch {
        reject(new AnalyzerError(`Analysis completed but output file not found: ${outputPath}`));
      }
    });
  });
}

function generateContextFile(binaryPath: string, workspacePath: string, swiftFiles: string[], outputPath: string) {
  runContextGenerator(binaryPath, workspacePath, swiftFiles, outputPath).catch(() => {});
}

function buildContextPrompt(nodeId: string, dependents: Record<string, string[]>): string {
  const lines: string[] = [];
  lines.push(`# SwiftPrism Context: ${nodeId}`);
  lines.push("");

  if (dependents.files?.length) {
    lines.push("## Related Files");
    for (const f of dependents.files) lines.push(`- ${f}`);
    lines.push("");
  }

  if (dependents.direct?.length) {
    lines.push("## Direct Dependencies");
    for (const d of dependents.direct) lines.push(`- ${d}`);
    lines.push("");
  }

  if (dependents.transitive?.length) {
    lines.push("## Transitive Dependencies (depth 3)");
    for (const t of dependents.transitive) lines.push(`- ${t}`);
    lines.push("");
  }

  if (dependents.resources?.length) {
    lines.push("## Resources");
    for (const r of dependents.resources) lines.push(`- ${r}`);
    lines.push("");
  }

  lines.push("---");
  lines.push(`> Generated by SwiftPrism. Query: \`swift-prism-analyzer --find-dependents-of "${nodeId}"\``);

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// MCP SERVER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Ensure .mcp.json exists in the workspace root with the SwiftPrism server config.
 * Uses a relative path to the MCP server dist — works from any machine.
 */
function ensureMcpConfig(extensionPath: string, workspaceRoot: string) {
  const mcpJsonPath = path.join(workspaceRoot, ".mcp.json");
  const mcpServerJs = path.join(extensionPath, "..", "mcp-server", "dist", "server.js");

  // Compute relative path from workspace root to the server.js
  let serverPath: string;
  if (fs.existsSync(mcpServerJs)) {
    serverPath = path.relative(workspaceRoot, mcpServerJs);
  } else {
    // Fallback: check if mcp-server is a sibling in a monorepo
    const monorepoServer = path.join(workspaceRoot, "mcp-server", "dist", "server.js");
    if (fs.existsSync(monorepoServer)) {
      serverPath = "mcp-server/dist/server.js";
    } else {
      outputChannel.appendLine("[mcp] MCP server dist not found — skipping .mcp.json auto-config");
      return;
    }
  }

  // Build the config with environment variables for settings
  const stealthMode = vscode.workspace.getConfiguration("swiftPrism.mcp").get<boolean>("stealthMode", false);
  const compression = vscode.workspace.getConfiguration("swiftPrism.mcp").get<boolean>("compression", false);

  const env: Record<string, string> = {};
  if (stealthMode) env.SWIFTPRISM_MODE = "stealth";
  if (compression) env.SWIFTPRISM_COMPRESS = "1";

  const mcpConfig: Record<string, any> = {
    mcpServers: {
      "swift-prism": {
        command: "node",
        args: [serverPath],
        ...(Object.keys(env).length > 0 ? { env } : {}),
      },
    },
  };

  // Read existing .mcp.json and merge (preserve other servers)
  let existing: Record<string, any> = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
    } catch { /* corrupt — overwrite */ }
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
async function configureMCPForDesktop(extensionPath: string) {
  const workspaceRoot = getWorkspaceRoot();
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("SwiftPrism: Open a workspace folder first.");
    return;
  }

  const mcpServerJs = path.join(extensionPath, "..", "mcp-server", "dist", "server.js");
  let serverPath: string;
  if (fs.existsSync(mcpServerJs)) {
    serverPath = mcpServerJs; // absolute for Claude Desktop
  } else {
    const monorepoServer = path.join(workspaceRoot.fsPath, "mcp-server", "dist", "server.js");
    if (fs.existsSync(monorepoServer)) {
      serverPath = monorepoServer;
    } else {
      vscode.window.showErrorMessage("SwiftPrism: MCP server dist not found. Run: cd mcp-server && npm run build");
      return;
    }
  }

  const stealthMode = vscode.workspace.getConfiguration("swiftPrism.mcp").get<boolean>("stealthMode", false);
  const compression = vscode.workspace.getConfiguration("swiftPrism.mcp").get<boolean>("compression", false);

  const env: Record<string, string> = { PRISM_CWD: workspaceRoot.fsPath };
  if (stealthMode) env.SWIFTPRISM_MODE = "stealth";
  if (compression) env.SWIFTPRISM_COMPRESS = "1";

  const config = {
    mcpServers: {
      swiftprism: {
        command: "node",
        args: [serverPath],
        env,
      },
    },
  };

  const snippet = JSON.stringify(config, null, 2);
  await vscode.env.clipboard.writeText(snippet);
  vscode.window.showInformationMessage(
    "SwiftPrism: MCP config copied to clipboard. Paste into ~/Library/Application Support/Claude/claude_desktop_config.json"
  );
}

export function deactivate() {
  activeProcess?.kill();
  activeProcess = null;
}
