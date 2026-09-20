import { useState, useCallback, useRef, useMemo } from "react";
import type {
  AnalysisResult,
  HostToWebviewMessage,
  ProgressInfo,
  FlatMapEntry,
  FilePreview,
  SemanticContextProgress,
} from "./protocol";
import { useVscodeMessaging, usePostMessage } from "./hooks/useVscodeMessaging";
import { Header } from "./components/Header";
import { GraphView } from "./components/GraphView";
import { JsonPreview } from "./components/JsonPreview";
import { GuideView } from "./components/GuideView";
import { StatusBar } from "./components/StatusBar";

export type ViewTab = "graph" | "json" | "guide";

const IDLE_PROGRESS: ProgressInfo = { phase: "idle", processed: 0, total: 0 };

function flatMapToAnalysisResult(entries: FlatMapEntry[]): AnalysisResult {
  const nodes = entries.map((e) => {
    const isTarget = e.flavor === "target";
    return {
      id: e.id,
      name: e.name,
      flavor: e.flavor as AnalysisResult["nodes"][number]["flavor"],
      subKind: null,
      isStatic: false,
      isGlobal: isTarget || e.parents.length === 0 || e.parents[0]?.endsWith(".swift"),
      isNested: false,
      isInteresting: true,
      access: "internal" as const,
      parent: e.parents[0]?.includes("::") ? e.parents[0].split("::").pop() ?? null : null,
      parentFile: e.parents[0]?.endsWith(".swift") ? e.parents[0] : null,
      sourceFile: isTarget ? (e.origin ?? e.location.absPath) : (e.location.absPath.split("/").pop() ?? e.location.absPath),
      location: { file: e.location.absPath, line: e.location.line, column: e.location.col },
      targetName: isTarget ? e.id : (e.id.split("::")[0] ?? null),
      memberCount: null,
      ...(e.locations ? { locations: e.locations.map(l => ({ file: l.absPath, line: l.line, column: l.col })) } : {}),
      ...(isTarget && e.origin ? { origin: e.origin } : {}),
    };
  });

  const nodeIds = new Set(entries.map((e) => e.id));

  // Execution links: calls + import_dependency
  const callLinks = entries.flatMap((e) =>
    (e.calls ?? [])
      .filter((targetId) => nodeIds.has(targetId))
      .map((targetId) => ({
        source_id: e.id,
        target_id: targetId,
        type: e.flavor === "target" ? "import_dependency" as const : "call" as const,
        confidence: null,
        references: null,
      }))
  );

  // Storage links: Object → stored type dependency
  const storeLinks = entries.flatMap((e) =>
    (e.stores ?? [])
      .filter((targetId) => nodeIds.has(targetId))
      .map((targetId) => ({
        source_id: e.id,
        target_id: targetId,
        type: "holds_type" as const,
        confidence: null,
        references: null,
      }))
  );

  const links = [...callLinks, ...storeLinks];

  return {
    projectRoot: null,
    nodes,
    links,
    resources: [],
    targets: [],
    macros: [],
    moduleNodes: null,
  };
}

export function App() {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [flatEntries, setFlatEntries] = useState<FlatMapEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressInfo>(IDLE_PROGRESS);
  const [activeTab, setActiveTab] = useState<ViewTab>("graph");
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const [contextToast, setContextToast] = useState<string | null>(null);
  const [jsonLoading, setJsonLoading] = useState(false);
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [semanticProgress, setSemanticProgress] = useState<SemanticContextProgress | null>(null);
  const [pendingContextIds, setPendingContextIds] = useState<Set<string>>(new Set());
  const [nodeContextMap, setNodeContextMap] = useState<Map<string, string>>(new Map());
  const postMessage = usePostMessage();

  const lkgResult = useRef<AnalysisResult | null>(null);

  const handleMessage = useCallback((msg: HostToWebviewMessage) => {
    switch (msg.type) {
      case "analysisResult": {
        const p = msg.payload;
        console.log(`[SwiftPrism] Received analysisResult: ${p.nodes.length} nodes, ${p.links.length} links, ${p.resources?.length ?? 0} resources`);
        if (p.nodes.length > 0) {
          const ids = new Set(p.nodes.map((n) => n.id));
          const broken = p.links.filter((l) => !ids.has(l.source_id) || !ids.has(l.target_id));
          if (broken.length > 0) console.warn(`[SwiftPrism] ${broken.length} links reference missing node IDs`);
        }
        lkgResult.current = p;
        // Force full state clear before applying new data
        setResult(null);
        setFlatEntries(null);
        setError(null);
        // Apply new data on next tick to ensure graph teardown completes
        setTimeout(() => {
          setResult(p);
          setProgress({ phase: "complete", processed: 1, total: 1 });
        }, 0);
        break;
      }
      case "mappingData": {
        console.log(`[SwiftPrism] Received mappingData: ${msg.payload.length} entries`);
        // Force full state clear before applying new data
        setResult(null);
        setFlatEntries(null);
        setError(null);
        setTimeout(() => {
          setFlatEntries(msg.payload);
          setProgress({ phase: "complete", processed: 1, total: 1 });
          setJsonLoading(false);
        }, 0);
        break;
      }
      case "progress":
        setProgress(msg.progress);
        setError(null);
        break;
      case "error":
        setProgress({ phase: "error", processed: 0, total: 0 });
        setError(msg.message);
        if (lkgResult.current) {
          setResult(lkgResult.current);
        }
        break;
      case "memberDetail":
        setResult((prev) => {
          if (!prev) return prev;
          const existingIds = new Set(prev.nodes.map((n) => n.id));
          const newNodes = msg.payload.nodes.filter((n) => !existingIds.has(n.id));
          const existingLinkKeys = new Set(prev.links.map((l) => `${l.source_id}->${l.target_id}`));
          const newLinks = msg.payload.links.filter((l) => !existingLinkKeys.has(`${l.source_id}->${l.target_id}`));
          return {
            ...prev,
            nodes: [...prev.nodes, ...newNodes],
            links: [...prev.links, ...newLinks],
          };
        });
        break;
      case "filePreview":
        setFilePreview(msg.payload);
        break;
      case "contextCopied":
        setContextToast(`Context copied (~${msg.tokenEstimate} tokens)`);
        setTimeout(() => setContextToast(null), 3000);
        break;
      case "semanticContextProgress":
        setSemanticProgress(msg.progress);
        break;
      case "semanticContextComplete":
        setSemanticProgress(null);
        setPendingContextIds(new Set());
        setContextToast(
          `Context: ${msg.enrichedCount} generated, ${msg.cachedCount} cached` +
          (msg.llmUsed ? " (LLM)" : " (fallback)")
        );
        setTimeout(() => setContextToast(null), 4000);
        break;
      case "nodeContextUpdate":
        // Single node finished — remove from pending, add to context map
        setPendingContextIds((prev) => {
          const next = new Set(prev);
          next.delete(msg.nodeId);
          return next;
        });
        setNodeContextMap((prev) => new Map(prev).set(msg.nodeId, msg.context));
        break;
      case "pendingContextIds":
        setPendingContextIds(new Set(msg.nodeIds));
        if (msg.nodeIds.length === 0) setNodeContextMap(new Map());
        break;
    }
  }, []);

  useVscodeMessaging(handleMessage);

  const displayResult = useMemo(() => {
    if (flatEntries) return flatMapToAnalysisResult(flatEntries);
    return result;
  }, [result, flatEntries]);

  const handleAnalyze = useCallback(() => {
    postMessage({ type: "analyzeRequest" });
  }, [postMessage]);

  const handleCopyContext = useCallback((nodeId: string) => {
    postMessage({ type: "copyContext", nodeId });
  }, [postMessage]);

  const handleOpenFile = useCallback((location: { file: string; line: number; col: number }) => {
    postMessage({ type: "openFile", data: location });
  }, [postMessage]);

  const handleRequestMembers = useCallback((nodeId: string) => {
    postMessage({ type: "requestMembers", nodeId });
  }, [postMessage]);

  const handleRequestFilePreview = useCallback((nodeId: string, filePath: string) => {
    postMessage({ type: "requestFilePreview", nodeId, filePath });
  }, [postMessage]);

  const handleClearPreview = useCallback(() => {
    setFilePreview(null);
  }, []);

  const handleViewRawJson = useCallback(() => {
    setJsonLoading(true);
    postMessage({ type: "requestRawJson" });
    setTimeout(() => setJsonLoading(false), 5000);
  }, [postMessage]);

  const handleGuideHighlight = useCallback((ids: Set<string>) => {
    setHighlightedIds(ids);
    if (ids.size > 0 && activeTab === "guide") {
      setActiveTab("graph");
    }
  }, [activeTab]);

  const isAnalyzing =
    progress.phase !== "idle" &&
    progress.phase !== "complete" &&
    progress.phase !== "error";

  const isLkg = error !== null && displayResult !== null;
  const hasResources = (displayResult?.resources?.length ?? 0) > 0;

  return (
    <div style={styles.root}>
      {error && <div style={styles.error}>{error}</div>}
      {semanticProgress && (
        <div style={styles.toast}>
          Processing Context... {semanticProgress.completed}/{semanticProgress.total}
          {semanticProgress.cached > 0 && ` (${semanticProgress.cached} cached)`}
          {semanticProgress.llmUsed ? " [LLM]" : " [fallback]"}
        </div>
      )}
      {contextToast && <div style={styles.toast}>{contextToast}</div>}
      <main style={styles.main}>
        {activeTab === "graph" && (
          <GraphView
            result={displayResult}
            highlightedIds={highlightedIds}
            onCopyContext={handleCopyContext}
            onOpenFile={handleOpenFile}
            onRequestMembers={handleRequestMembers}
            onRequestFilePreview={handleRequestFilePreview}
            onClearPreview={handleClearPreview}
            filePreview={filePreview}
            pendingContextIds={pendingContextIds}
            nodeContextMap={nodeContextMap}
          />
        )}
        {activeTab === "json" && <JsonPreview result={displayResult} />}
        {activeTab === "guide" && (
          <GuideView
            result={displayResult}
            onHighlight={handleGuideHighlight}
            onCopyContext={handleCopyContext}
          />
        )}
      </main>
      <Header
        result={displayResult}
        loading={isAnalyzing}
        onAnalyze={handleAnalyze}
        onViewRawJson={handleViewRawJson}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isLkg={isLkg}
        hasResources={hasResources}
        jsonLoading={jsonLoading}
      />
      <StatusBar progress={progress} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    width: "100vw",
    overflow: "hidden",
    fontFamily: "var(--vscode-font-family)",
    color: "var(--vscode-foreground)",
    background: "var(--vscode-sideBar-background)",
  },
  error: {
    color: "var(--vscode-errorForeground)",
    background: "var(--vscode-inputValidation-errorBackground)",
    border: "1px solid var(--vscode-inputValidation-errorBorder)",
    borderRadius: 4,
    padding: "8px 12px",
    margin: "8px 12px 0",
    fontSize: "0.9em",
  },
  toast: {
    background: "var(--vscode-badge-background)",
    color: "var(--vscode-badge-foreground)",
    borderRadius: 4,
    padding: "6px 12px",
    margin: "8px 12px 0",
    fontSize: "0.85em",
    textAlign: "center" as const,
  },
  main: {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    position: "relative",
  },
};
