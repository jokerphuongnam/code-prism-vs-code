import type {
  FlatGraphNode,
  FlatGraphResult,
  SymbolFlavor,
} from "../protocol";
import type * as vscode from "vscode";

interface ExecutionChainResult {
  executionChain: string[];
  visitedFiles: Set<string>;
}

interface PruningManifest {
  requiredSymbols: string[];
  prunedSymbols: string[];
  activeFrameworks: string[];
}

interface NodeSummary {
  id: string;
  name: string;
  flavor: SymbolFlavor;
  isVisibleInGraph: boolean;
  impactScore: "high" | "low";
}

type NodeIndex = Map<string, FlatGraphNode>;
type ChildIndex = Map<string, FlatGraphNode[]>;

const OBJECT_FLAVORS: ReadonlySet<SymbolFlavor> = new Set([
  "struct", "class", "enum", "actor", "protocol",
]);

const EXECUTABLE_FLAVORS: ReadonlySet<string> = new Set([
  "function", "getter", "setter", "willSet", "didSet",
]);

function buildNodeIndex(nodes: FlatGraphNode[]): NodeIndex {
  const index: NodeIndex = new Map();
  for (const node of nodes) {
    index.set(node.id, node);
  }
  return index;
}

function buildChildIndex(nodes: FlatGraphNode[]): ChildIndex {
  const index: ChildIndex = new Map();
  for (const node of nodes) {
    for (const parentId of node.parents) {
      const existing = index.get(parentId);
      if (existing) {
        existing.push(node);
      } else {
        index.set(parentId, [node]);
      }
    }
  }
  return index;
}

function collectNodeFiles(node: FlatGraphNode): string[] {
  if (node.location.absPath) {
    return [node.location.absPath];
  }
  return [];
}

function classifyImpact(node: FlatGraphNode): "high" | "low" {
  if (node.calls.length > 0) return "high";
  if (node.inits && node.inits.length > 0) return "high";
  if (EXECUTABLE_FLAVORS.has(node.flavor)) return "high";
  if (OBJECT_FLAVORS.has(node.flavor)) return "high";
  return "low";
}

function isVisibleSymbol(node: FlatGraphNode): boolean {
  if (node.flavor === "target") return true;
  if (OBJECT_FLAVORS.has(node.flavor)) return true;
  if (EXECUTABLE_FLAVORS.has(node.flavor)) return true;
  if (node.flavor === "macro") return true;
  // Variables are only visible if they have an executable body (computed/observer)
  // Stored properties (no body) are forbidden from the graph
  if (node.flavor === "variable") return false;
  return false;
}

export class PruningEngineService {
  private readonly nodeIndex: NodeIndex;
  private readonly childIndex: ChildIndex;
  private readonly result: FlatGraphResult;
  private readonly webview: vscode.Webview | null;

  constructor(result: FlatGraphResult, webview?: vscode.Webview) {
    this.result = result;
    this.nodeIndex = buildNodeIndex(result.nodes);
    this.childIndex = buildChildIndex(result.nodes);
    this.webview = webview ?? null;
  }

  analyzeExecutionChain(rootNodeId: string): ExecutionChainResult {
    const visited = new Set<string>();
    const visitedFiles = new Set<string>();
    const chain: string[] = [];

    this.dfsTrace(rootNodeId, visited, visitedFiles, chain);

    return { executionChain: chain, visitedFiles };
  }

  getPruningManifest(targetFile: string): PruningManifest {
    const fileNodes = this.result.nodes.filter((n) => {
      const files = collectNodeFiles(n);
      return files.some((f) => f.endsWith(targetFile) || f === targetFile);
    });

    if (fileNodes.length === 0) {
      return { requiredSymbols: [], prunedSymbols: [], activeFrameworks: [] };
    }

    const rootNode = fileNodes.find((n) => OBJECT_FLAVORS.has(n.flavor));
    if (!rootNode) {
      return {
        requiredSymbols: fileNodes.map((n) => n.id),
        prunedSymbols: [],
        activeFrameworks: this.extractFrameworksFromCalls(fileNodes),
      };
    }

    const { executionChain } = this.analyzeExecutionChain(rootNode.id);
    const chainSet = new Set(executionChain);

    const requiredSymbols: string[] = [];
    const prunedSymbols: string[] = [];

    for (const node of fileNodes) {
      if (chainSet.has(node.id)) {
        requiredSymbols.push(node.id);
      } else {
        prunedSymbols.push(node.id);
      }
    }

    const allFrameworks = this.extractFrameworksFromCalls(fileNodes);
    const activeFrameworks = allFrameworks.filter((framework) =>
      this.hasRequiredCallToTarget(framework, chainSet)
    );

    return { requiredSymbols, prunedSymbols, activeFrameworks };
  }

  getNodeSummaries(nodeIds: string[]): NodeSummary[] {
    return nodeIds.reduce<NodeSummary[]>((summaries, id) => {
      const node = this.nodeIndex.get(id);
      if (node) {
        summaries.push({
          id: node.id,
          name: node.name,
          flavor: node.flavor,
          isVisibleInGraph: isVisibleSymbol(node),
          impactScore: classifyImpact(node),
        });
      }
      return summaries;
    }, []);
  }

  resolveWebviewUri(filePath: string): string {
    if (this.webview) {
      const uri = { scheme: "file", path: filePath } as vscode.Uri;
      return this.webview.asWebviewUri(uri).toString();
    }
    return filePath;
  }

  private dfsTrace(
    nodeId: string,
    visited: Set<string>,
    visitedFiles: Set<string>,
    chain: string[]
  ): void {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    chain.push(nodeId);

    const node = this.nodeIndex.get(nodeId);
    if (!node) return;

    for (const file of collectNodeFiles(node)) {
      visitedFiles.add(file);
    }

    for (const call of node.calls) {
      const isExternalTarget = this.result.targets.some(
        (t) => t.isExternal && (call.target === t.name || call.target.startsWith(`${t.name}::`))
      );
      if (isExternalTarget) {
        visited.add(call.target);
        chain.push(call.target);
        continue;
      }
      this.dfsTrace(call.target, visited, visitedFiles, chain);
    }

    if (node.inits) {
      for (const initTarget of node.inits) {
        this.dfsTrace(initTarget, visited, visitedFiles, chain);
      }
    }

    if (node.deinits) {
      for (const deinitTarget of node.deinits) {
        this.dfsTrace(deinitTarget, visited, visitedFiles, chain);
      }
    }

    // Walk into children only for Object containers and target hubs
    if (OBJECT_FLAVORS.has(node.flavor) || node.flavor === "target") {
      const children = this.childIndex.get(node.id) ?? [];
      for (const child of children) {
        this.dfsTrace(child.id, visited, visitedFiles, chain);
      }
    }

    const typeRefs = [...(node.returnTypes ?? []), ...(node.parameterTypes ?? [])];
    for (const typeName of typeRefs) {
      const typeNode = this.result.nodes.find((n) => n.name === typeName && OBJECT_FLAVORS.has(n.flavor));
      if (typeNode) {
        this.dfsTrace(typeNode.id, visited, visitedFiles, chain);
      }
    }
  }

  private extractFrameworksFromCalls(nodes: FlatGraphNode[]): string[] {
    const frameworks = new Set<string>();
    for (const node of nodes) {
      for (const call of node.calls) {
        const parts = call.target.split("::");
        if (parts.length >= 2) {
          const targetModule = parts[0];
          const isExternal = this.result.targets.some(
            (t) => t.name === targetModule && t.isExternal
          );
          if (isExternal) {
            frameworks.add(targetModule);
          }
        }
      }
    }
    return Array.from(frameworks);
  }

  private hasRequiredCallToTarget(
    framework: string,
    requiredSet: Set<string>
  ): boolean {
    for (const node of this.result.nodes) {
      if (!requiredSet.has(node.id)) continue;
      for (const call of node.calls) {
        if (call.target.startsWith(`${framework}::`)) {
          return true;
        }
      }
    }
    return false;
  }
}
