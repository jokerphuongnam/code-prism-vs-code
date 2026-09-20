/**
 * analyzerBridge.ts — v3.1 Scope-Stack Rewrite
 *
 * Complete rewrite of the hierarchical transformation layer.
 * The ScopeStack is the SINGLE SOURCE OF TRUTH for every node's
 * parents[] array. No parallel parent-chain walks.
 *
 * Architecture:
 *   1. Target Discovery  — Package.swift / .xcodeproj parsed by binary,
 *                           nodes grouped by targetName
 *   2. Scope Stack Walk  — [Target, File, Object, Member] maintained
 *                           during recursive traversal; parents = snapshot
 *   3. Body-Only Filter  — Stored properties PROHIBITED; only executable
 *                           blocks (func/init/deinit/get/set/willSet/didSet/
 *                           computed body) produce nodes
 *   4. Call Routing       — init/deinit calls → parent Object's inits[]/deinits[];
 *                           all other calls → member's calls[]
 *   5. Leaf-Level Trace  — Every call resolves to Target::Object::Member,
 *                           using the CALLEE's target (cross-target safe)
 */

import { spawn, execFile, type ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import type {
  AnalysisResult,
  ProgressInfo,
  PrismNode,
  PrismLink,
  SourcePosition,
  CallRef,
  FlatGraphNode,
  EntryPointNode,
  TargetGroup,
  FlatGraphResult,
  ResourceNode,
  TargetInfo,
} from "./protocol";

export const LOGIC_VERSION = "4.0-target-hub";

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

export class AnalyzerError extends Error {
  public readonly stderr: string;
  constructor(message: string, stderr: string = "") {
    super(message);
    this.name = "AnalyzerError";
    this.stderr = stderr;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA VALIDATOR — Rejects nodes that don't comply with v4.0 flat-graph schema
// ═══════════════════════════════════════════════════════════════════════════════

export class SchemaValidator {
  static validate(nodes: FlatGraphNode[]): void {
    for (const node of nodes) {
      // Target hub nodes have different rules — plain ID, no parents required
      if (node.flavor === "target") continue;

      if (!node.parents || !Array.isArray(node.parents) || node.parents.length === 0) {
        throw new AnalyzerError(
          `FATAL: Node "${node.id}" is missing parents[]. Every node must have at least one parent.`
        );
      }
      if (!node.id.includes("::")) {
        throw new AnalyzerError(
          `FATAL: Node "${node.id}" has invalid ID format. Must use Target::Object::Member namespace.`
        );
      }
      if ("connections" in node) {
        throw new AnalyzerError(
          `FATAL: Node "${node.id}" contains deprecated 'connections' field. Use calls[]/inits[]/deinits[].`
        );
      }
      if (!node.calls || !Array.isArray(node.calls)) {
        throw new AnalyzerError(
          `FATAL: Node "${node.id}" is missing calls[]. Every node must have a calls array (even if empty).`
        );
      }
      if (node.flavor === "initializer" || node.name === "deinit") {
        throw new AnalyzerError(
          `FATAL: Node "${node.id}" has flavor "${node.flavor}". Init/deinit must not be independent nodes — their calls belong in the parent Object's inits[]/deinits[].`
        );
      }
    }
  }

  static hardValidateJson(json: string): void {
    const banned = ['"connections"', '"parentFile"', '"subKind"', '"isStatic"', '"isGlobal"', '"isNested"', '"memberCount"'];
    for (const keyword of banned) {
      if (json.includes(keyword)) {
        throw new AnalyzerError(
          `FATAL_OLD_SCHEMA_ERROR: Stringified JSON contains banned key ${keyword}. Aborting file write.`
        );
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AnalyzerCallbacks {
  onProgress: (progress: ProgressInfo) => void;
  onWarning: (message: string) => void;
}

export interface FlatMapEntry {
  id: string;
  name: string;
  flavor: string;
  location: { absPath: string; line: number; col: number };
  parents: string[];
  calls?: string[];
  /** Object-only: extension block locations for "Defined In" navigation */
  locations?: { absPath: string; line: number; col: number }[];
  inits?: string[];
  deinits?: string[];
  extends?: string | null;
  implements?: string[];
  stores?: string[];
  returns?: string[];
  parameters?: string[];
  origin?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BINARY RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════════

export function resolveAnalyzerBinary(extensionPath: string): string {
  return path.join(extensionPath, "bin", "swift-prism-analyzer");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════════

const OBJECT_FLAVORS = new Set(["struct", "class", "enum", "actor", "protocol"]);
const OBSERVER_SUBKINDS = new Set(["willSet", "didSet", "getter", "setter", "computed"]);
const EXTERNAL_PATH_MARKERS = [".build/checkouts", "SourcePackages/checkouts", "Pods/", "DerivedData/"];

// ═══════════════════════════════════════════════════════════════════════════════
// SIGNATURE-AWARE NAMING
//
// Functions and initializers can be overloaded. The `signature` field from the
// binary contains argument labels like "(id:)" or "(data:metadata:)".
//
//   name (display): "fetch(id:)"       — human-readable label for graph/UI
//   id   (linking): "Target::File::Store::fetch(id:)" — unique qualified path
//
// When signature is null/empty, the plain name is used (no overloads).
// ═══════════════════════════════════════════════════════════════════════════════

function signedName(node: PrismNode): string {
  if (node.signature && (node.flavor === "function" || node.flavor === "initializer")) {
    return `${node.name}${node.signature}`;
  }
  return node.name;
}

function signedNameForCallee(node: PrismNode, link: PrismLink): string {
  const sig = link.targetSignature ?? node.signature;
  if (sig && (node.flavor === "function" || node.flavor === "initializer")) {
    return `${node.name}${sig}`;
  }
  return node.name;
}

function isStoredProperty(node: PrismNode): boolean {
  return node.flavor === "variable" && (node.subKind === "stored" || node.subKind === null);
}

function isObserverProperty(node: PrismNode): boolean {
  return node.flavor === "variable" && node.subKind !== null && OBSERVER_SUBKINDS.has(node.subKind);
}

function hasBody(node: PrismNode): boolean {
  if (node.flavor === "function" || node.flavor === "initializer") return true;
  if (node.flavor === "variable" && node.subKind !== null && node.subKind !== "stored") return true;
  return false;
}


function pos(node: PrismNode): SourcePosition {
  return { line: node.location.line, col: node.location.column, absPath: node.location.file };
}

function isExternal(info: TargetInfo | undefined, nodes: PrismNode[]): boolean {
  if (!info) return true;
  for (const marker of EXTERNAL_PATH_MARKERS) {
    if (info.path.includes(marker)) return true;
  }
  if (info.path && nodes.length > 0) {
    return !nodes.some((n) => n.sourceFile.includes(info.path));
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALL RESOLUTION — Leaf-Level, Cross-Target Safe
//
// Rules:
//   d.e()       → CalleeTarget::ClassD::functionE  (method call)
//   let d = D() → CalleeTarget::ClassD             (init → resolve to class)
//   deinit body → calls go into parent Object's deinits[]
//   init body   → calls go into parent Object's inits[]
// ═══════════════════════════════════════════════════════════════════════════════

function resolveLeafTarget(
  calleeNode: PrismNode,
  nodeById: Map<string, PrismNode>,
  link: PrismLink
): string {
  if (calleeNode.flavor === "initializer" && calleeNode.parent) {
    const parentObj = nodeById.get(calleeNode.parent);
    if (parentObj && OBJECT_FLAVORS.has(parentObj.flavor)) {
      return buildIdFromChain(parentObj, nodeById);
    }
  }
  return buildIdFromChain(calleeNode, nodeById, link);
}

/**
 * Build a fully-qualified ID by walking the flat parent chain.
 * Uses the CALLEE's own targetName (cross-target safe).
 * Appends the signature for the leaf node to disambiguate overloads.
 *
 *   fetch(id:)   → NetworkKit::APIClient::fetch(id:)
 *   fetch(name:) → NetworkKit::APIClient::fetch(name:)
 */
function buildIdFromChain(
  node: PrismNode,
  nodeById: Map<string, PrismNode>,
  link?: PrismLink
): string {
  const parts: string[] = [];
  let current: PrismNode | undefined = node;
  while (current) {
    if (current === node) {
      parts.unshift(link ? signedNameForCallee(current, link) : signedName(current));
    } else {
      parts.unshift(signedName(current));
    }
    current = current.parent ? nodeById.get(current.parent) : undefined;
  }
  const target = node.targetName ?? "__default__";
  parts.unshift(target);
  return parts.join("::");
}

function traceOutgoingCalls(
  sourceId: string,
  links: PrismLink[],
  nodeById: Map<string, PrismNode>
): CallRef[] {
  const calls: CallRef[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    if (link.source_id !== sourceId) continue;
    if (link.type !== "call" && link.type !== "access" && link.type !== "observer_trigger") continue;

    const callee = nodeById.get(link.target_id);
    if (!callee) continue;

    const target = resolveLeafTarget(callee, nodeById, link);
    if (seen.has(target)) continue;
    seen.add(target);

    const callPos: SourcePosition = link.references?.[0]
      ? { line: link.references[0].line, col: link.references[0].column, absPath: link.references[0].file }
      : pos(callee);

    calls.push({ target, location: callPos });
  }

  return calls;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TARGET DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════════

function groupByTarget(result: AnalysisResult): {
  infoMap: Map<string, TargetInfo>;
  nodeMap: Map<string, PrismNode[]>;
  resMap: Map<string, ResourceNode[]>;
} {
  const infoMap = new Map<string, TargetInfo>();
  for (const t of result.targets) infoMap.set(t.name, t);

  const nodeMap = new Map<string, PrismNode[]>();
  for (const n of result.nodes) {
    if (!n.id) continue;
    const t = n.targetName ?? "__default__";
    (nodeMap.get(t) ?? (nodeMap.set(t, []), nodeMap.get(t)!)).push(n);
  }

  const resMap = new Map<string, ResourceNode[]>();
  for (const r of result.resources) {
    let placed = false;
    for (const t of result.targets) {
      if (t.path && r.filePath.includes(t.path)) {
        (resMap.get(t.name) ?? (resMap.set(t.name, []), resMap.get(t.name)!)).push(r);
        placed = true;
        break;
      }
    }
    if (!placed) {
      (resMap.get("__default__") ?? (resMap.set("__default__", []), resMap.get("__default__")!)).push(r);
    }
  }

  return { infoMap, nodeMap, resMap };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENTRY POINT DETECTION — GLOBAL::MAIN
// ═══════════════════════════════════════════════════════════════════════════════

function findEntryPoint(
  nodes: PrismNode[],
  targetName: string,
  links: PrismLink[],
  nodeById: Map<string, PrismNode>
): EntryPointNode | null {
  // Priority 1: @main
  const ep = nodes.find((n) => n.flavor === "entry_point" && n.targetName === targetName);
  if (ep) {
    return {
      id: "GLOBAL::MAIN",
      kind: "@main",
      location: pos(ep),
      parents: [targetName],
      calls: traceOutgoingCalls(ep.id, links, nodeById),
    };
  }

  // Priority 2: main.swift globals
  const mainGlobal = nodes.find(
    (n) => n.targetName === targetName && n.sourceFile.endsWith("/main.swift") && n.isGlobal
  );
  if (mainGlobal) {
    const allGlobals = nodes.filter(
      (n) => n.targetName === targetName && n.sourceFile === mainGlobal.sourceFile && n.isGlobal
    );
    const allCalls: CallRef[] = [];
    for (const g of allGlobals) allCalls.push(...traceOutgoingCalls(g.id, links, nodeById));
    return {
      id: "GLOBAL::MAIN",
      kind: "main.swift",
      location: pos(mainGlobal),
      parents: [targetName],
      calls: allCalls,
    };
  }

  // Priority 3: AppDelegate
  const ad = nodes.find(
    (n) => n.targetName === targetName && n.name.includes("AppDelegate") && OBJECT_FLAVORS.has(n.flavor)
  );
  if (ad) {
    return {
      id: "GLOBAL::MAIN",
      kind: "AppDelegate",
      location: pos(ad),
      parents: [targetName],
      calls: traceOutgoingCalls(ad.id, links, nodeById),
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARENTING — Single Lexical Parent
//
// Object (top-level):    parents: ["Declaration.swift"]
// Object (nested):       parents: ["Target::OwnerObject"]
// Member (func/observer): parents: ["Target::OwnerObject"]
// Global (top-level func): parents: ["FileName.swift"]
//
// Extension members attach to the PRIMARY Object ID via parents[].
// Each member's location.absPath points to the file where it is written,
// enabling precise "Click-to-Code" navigation even across extension files.
// ═══════════════════════════════════════════════════════════════════════════════


/**
 * qualifiedPath is the full nesting chain: "Network::Session" for a nested type,
 * or just "AppDelegate" for a top-level type. All ID builders prepend targetName.
 */
function buildObjectId(targetName: string, qualifiedPath: string): string {
  return `${targetName}::${qualifiedPath}`;
}

function buildMemberId(targetName: string, qualifiedPath: string, memberName: string): string {
  return `${targetName}::${qualifiedPath}::${memberName}`;
}

function buildObserverId(targetName: string, qualifiedPath: string, propName: string, observerKind: string): string {
  return `${targetName}::${qualifiedPath}::${propName}::${observerKind}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FLAT WALKER — Emits nodes into a shared flat array
//
// Init/deinit do NOT produce independent nodes. Their outgoing calls are
// extracted and stored as string IDs in the parent Object's inits[]/deinits[].
// Only regular members (func, accessor, observer) become flat nodes.
// ═══════════════════════════════════════════════════════════════════════════════

function flatWalkObject(
  obj: PrismNode,
  targetNodes: PrismNode[],
  links: PrismLink[],
  nodeById: Map<string, PrismNode>,
  targetName: string,
  out: FlatGraphNode[],
  targetHubIds?: Set<string>,
  parentObjectId?: string,
  parentQualifiedPath?: string
): void {
  const objName = obj.name;
  const qualifiedPath = parentQualifiedPath
    ? `${parentQualifiedPath}::${objName}`
    : objName;
  const objId = buildObjectId(targetName, qualifiedPath);
  const children = targetNodes.filter((n) => n.parent === obj.id);

  const initIds: string[] = [];
  const deinitIds: string[] = [];

  for (const child of children) {
    const childSigned = signedName(child);

    if (child.flavor === "initializer") {
      const calls = traceOutgoingCalls(child.id, links, nodeById);
      for (const c of calls) initIds.push(c.target);
      continue;
    }

    if (child.name === "deinit" && child.flavor === "function") {
      const calls = traceOutgoingCalls(child.id, links, nodeById);
      for (const c of calls) deinitIds.push(c.target);
      continue;
    }

    if (isStoredProperty(child)) continue;

    if (isObserverProperty(child)) {
      const subNodes = targetNodes.filter((n) => n.parent === child.id);
      if (subNodes.length > 0) {
        for (const obs of subNodes) {
          const kind = obs.subKind ?? obs.name;
          out.push({
            id: buildObserverId(targetName, qualifiedPath, child.name, kind),
            name: `${child.name}::${kind}`,
            flavor: obs.flavor,
            location: pos(obs),
            parents: [objId],
            calls: traceOutgoingCalls(obs.id, links, nodeById),
          });
        }
      } else {
        const kind = child.subKind ?? "body";
        out.push({
          id: buildObserverId(targetName, qualifiedPath, child.name, kind),
          name: `${child.name}::${kind}`,
          flavor: child.flavor,
          location: pos(child),
          parents: [objId],
          calls: traceOutgoingCalls(child.id, links, nodeById),
        });
      }
      continue;
    }

    if (OBJECT_FLAVORS.has(child.flavor)) {
      flatWalkObject(child, targetNodes, links, nodeById, targetName, out, targetHubIds, objId, qualifiedPath);
      continue;
    }

    if (hasBody(child)) {
      out.push({
        id: buildMemberId(targetName, qualifiedPath, childSigned),
        name: childSigned,
        flavor: child.flavor,
        location: pos(child),
        parents: [objId],
        calls: traceOutgoingCalls(child.id, links, nodeById),
      });
      continue;
    }
  }

  // Resolve extends / implements
  let extendsId: string | null = null;
  const implementsIds: string[] = [];
  for (const link of links) {
    if (link.source_id !== obj.id) continue;
    const target = nodeById.get(link.target_id);
    const qId = target ? buildIdFromChain(target, nodeById) : link.target_id;
    if (link.type === "inheritance") {
      if (obj.flavor === "class" && !extendsId) extendsId = qId;
      else implementsIds.push(qId);
    } else if (link.type === "conformance") {
      implementsIds.push(qId);
    }
  }
  for (const link of links) {
    if (link.target_id !== obj.id || link.type !== "extension_contribution") continue;
    const extNode = nodeById.get(link.source_id);
    if (!extNode) continue;
    for (const extLink of links) {
      if (extLink.source_id !== extNode.id || extLink.type !== "conformance") continue;
      const proto = nodeById.get(extLink.target_id);
      const pId = proto ? buildIdFromChain(proto, nodeById) : extLink.target_id;
      if (!implementsIds.includes(pId)) implementsIds.push(pId);
    }
  }

  // Collect extension block locations from extension_contribution links
  const extLocations: SourcePosition[] = [];
  const seenExtFiles = new Set<string>();
  for (const link of links) {
    if (link.target_id !== obj.id || link.type !== "extension_contribution") continue;
    const extFile = link.source_id.startsWith("file:") ? link.source_id.slice(5) : link.source_id;
    if (seenExtFiles.has(extFile)) continue;
    seenExtFiles.add(extFile);
    // Find the first member in this extension file to approximate the extension block location
    const extMember = targetNodes.find((n) => n.parent === obj.id && n.sourceFile === extFile);
    extLocations.push({
      absPath: extFile,
      line: extMember?.location.line ?? 1,
      col: extMember?.location.column ?? 1,
    });
  }

  // Collect stored property type dependencies from holds_type links
  const storeIds: string[] = [];
  const seenStores = new Set<string>();
  for (const link of links) {
    if (link.source_id !== obj.id || link.type !== "holds_type") continue;
    const target = nodeById.get(link.target_id);
    const qId = target ? buildIdFromChain(target, nodeById) : link.target_id;
    if (!seenStores.has(qId)) { seenStores.add(qId); storeIds.push(qId); }
  }

  out.push({
    id: objId,
    name: objName,
    flavor: obj.flavor,
    location: pos(obj),
    parents: parentObjectId ? [parentObjectId] : [path.basename(obj.sourceFile)],
    calls: [],
    ...(extLocations.length > 0 ? { locations: extLocations } : {}),
    ...(storeIds.length > 0 ? { stores: storeIds } : {}),
    extends: extendsId,
    implements: implementsIds,
    inits: initIds,
    deinits: deinitIds,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN TRANSFORMATION — Produces a flat array of unique nodes
// ═══════════════════════════════════════════════════════════════════════════════

export function transformToFlat(
  result: AnalysisResult
): FlatGraphResult {
  const nodeById = new Map<string, PrismNode>();
  for (const n of result.nodes) {
    if (n.id) nodeById.set(n.id, n);
  }

  const { infoMap, nodeMap, resMap } = groupByTarget(result);
  const targets: TargetGroup[] = [];
  const allNodes: FlatGraphNode[] = [];
  const allNames = new Set([...result.targets.map((t) => t.name), ...nodeMap.keys()]);

  // ── Phase 0: Emit target-flavor nodes as hub entries ──
  const targetHubIds = new Set<string>();
  for (const n of result.nodes) {
    if (n.flavor !== "target") continue;
    targetHubIds.add(n.id);
    // Collect import_dependency calls from this target
    const depCalls: CallRef[] = [];
    for (const link of result.links) {
      if (link.source_id !== n.id || link.type !== "import_dependency") continue;
      depCalls.push({ target: link.target_id, location: pos(n) });
    }
    allNodes.push({
      id: n.id,
      name: n.name,
      flavor: "target",
      location: pos(n),
      parents: [],
      calls: depCalls,
      origin: n.sourceFile || undefined, // internal targets have empty sourceFile → omit origin
    });
  }

  // ── Phase 1: Process each code target ──
  for (const tName of allNames) {
    const nodes = nodeMap.get(tName) ?? [];
    const info = infoMap.get(tName);

    // Skip target-hub-only groups (already emitted above)
    if (targetHubIds.has(tName) && nodes.every((n) => n.flavor === "target")) {
      targets.push({
        name: tName,
        type: info?.type ?? "unknown",
        path: info?.path ?? "",
        dependencies: info?.dependencies ?? [],
        isExternal: !nodes.some((n) => n.flavor !== "target"),
        entryPoint: null,
        resources: resMap.get(tName) ?? [],
      });
      continue;
    }

    if (isExternal(info, nodes) && tName !== "__default__") {
      targets.push({
        name: tName,
        type: info?.type ?? "unknown",
        path: info?.path ?? "",
        dependencies: info?.dependencies ?? [],
        isExternal: true,
        entryPoint: null,
        resources: [],
      });
      continue;
    }

    const entryPoint = findEntryPoint(nodes, tName, result.links, nodeById);

    // Top-level objects → flat walk (dedup by name for extension merging)
    const topObjects = nodes.filter((n) => OBJECT_FLAVORS.has(n.flavor) && !n.parent);
    const seenNames = new Set<string>();
    for (const obj of topObjects) {
      if (seenNames.has(obj.name)) continue;
      seenNames.add(obj.name);
      flatWalkObject(obj, nodes, result.links, nodeById, tName, allNodes, targetHubIds);
    }

    // Global functions — parent includes owning target if it's a hub
    const globalFuncs = nodes.filter((n) => n.flavor === "function" && n.isGlobal && !n.parent);
    for (const fn of globalFuncs) {
      if (!hasBody(fn)) continue;
      const fnSigned = signedName(fn);
      const fileName = path.basename(fn.sourceFile);
      const parents = [fileName];
      allNodes.push({
        id: `${tName}::${fileName}::${fnSigned}`,
        name: fnSigned,
        flavor: fn.flavor,
        location: pos(fn),
        parents,
        calls: traceOutgoingCalls(fn.id, result.links, nodeById),
      });
    }

    targets.push({
      name: tName,
      type: info?.type ?? "unknown",
      path: info?.path ?? "",
      dependencies: info?.dependencies ?? [],
      isExternal: false,
      entryPoint,
      resources: resMap.get(tName) ?? [],
    });
  }

  SchemaValidator.validate(allNodes);

  const output: FlatGraphResult = {
    schemaVersion: LOGIC_VERSION,
    projectRoot: result.projectRoot ?? "",
    targets,
    nodes: allNodes,
  };

  return output;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BINARY I/O
// ═══════════════════════════════════════════════════════════════════════════════

export function runSwiftAnalyzerToPath(
  binaryPath: string,
  projectPath: string,
  outputPath: string
): Promise<FlatMapEntry[]> {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      [projectPath, outputPath],
      { timeout: 300_000, maxBuffer: 50 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new AnalyzerError(`Analyzer failed: ${extractErr(stderr) || error.message}`, stderr));
          return;
        }
        if (!fs.existsSync(outputPath)) {
          reject(new AnalyzerError(`Output file not found: ${outputPath}`, stderr));
          return;
        }
        let raw: string;
        try { raw = fs.readFileSync(outputPath, "utf-8"); }
        catch (e) { reject(new AnalyzerError(`Cannot read output: ${e}`, stderr)); return; }
        if (!raw.trim()) { reject(new AnalyzerError("Empty output", stderr)); return; }
        try {
          const entries: FlatMapEntry[] = JSON.parse(raw);
          if (!Array.isArray(entries)) { reject(new AnalyzerError("Not an array", stderr)); return; }
          resolve(entries);
        } catch {
          reject(new AnalyzerError(`Invalid JSON. Preview: ${raw.slice(0, 200)}`, stderr));
        }
      }
    );
  });
}

export function runAnalyzer(
  binaryPath: string,
  args: string[],
  callbacks: AnalyzerCallbacks
): { promise: Promise<AnalysisResult>; process: ChildProcess } {
  const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  const bufs: Buffer[] = [];
  let stderr = "";

  child.stdout.on("data", (chunk: Buffer) => {
    bufs.push(chunk);
    callbacks.onProgress({ phase: "streaming", processed: 0, total: 0 });
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const t = chunk.toString();
    stderr += t;
    parseStderr(t, callbacks);
  });

  const promise = new Promise<AnalysisResult>((resolve, reject) => {
    child.on("error", (err) => reject(new AnalyzerError(`Launch failed: ${err.message}`, stderr)));
    child.on("close", (code) => {
      if (code !== 0) { reject(new AnalyzerError(extractErr(stderr) || `Exit code ${code}`, stderr)); return; }
      const out = Buffer.concat(bufs).toString("utf-8");
      if (!out.trim()) { reject(new AnalyzerError("Empty output", stderr)); return; }
      try { resolve(JSON.parse(out)); }
      catch { reject(new AnalyzerError(`Invalid JSON. Preview: ${out.slice(0, 200)}`, stderr)); }
    });
  });

  return { promise, process: child };
}

// TODO: Potential Redundant — runFlatAnalysis not currently imported by any consumer
export function runFlatAnalysis(
  binaryPath: string,
  args: string[],
  callbacks: AnalyzerCallbacks
): { promise: Promise<FlatGraphResult>; process: ChildProcess } {
  const { promise, process: child } = runAnalyzer(binaryPath, args, callbacks);
  return { promise: promise.then(transformToFlat), process: child };
}

export function runSummaryAnalysis(
  binaryPath: string,
  args: string[],
  callbacks: AnalyzerCallbacks
): { promise: Promise<AnalysisResult>; process: ChildProcess } {
  return runAnalyzer(binaryPath, [...args, "--summary-only"], callbacks);
}

export function runMembersOf(
  binaryPath: string,
  parentId: string,
  args: string[]
): Promise<AnalysisResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, [...args, "--members-of", parentId], { stdio: ["ignore", "pipe", "pipe"] });
    const bufs: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => bufs.push(c));
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (e) => reject(new AnalyzerError(e.message, stderr)));
    child.on("close", (code) => {
      if (code !== 0) { reject(new AnalyzerError(extractErr(stderr) || `Members failed (${code})`, stderr)); return; }
      try { resolve(JSON.parse(Buffer.concat(bufs).toString("utf-8"))); }
      catch { reject(new AnalyzerError("Parse failed", stderr)); }
    });
  });
}

export function runContextGenerator(
  binaryPath: string,
  workspacePath: string,
  swiftFiles: string[],
  outputPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["--workspace", workspacePath, "--context", "--output", outputPath, ...swiftFiles], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (e) => reject(new AnalyzerError(e.message, stderr)));
    child.on("close", (code) => {
      if (code !== 0) reject(new AnalyzerError(extractErr(stderr) || `Context gen failed (${code})`, stderr));
      else resolve();
    });
  });
}

export function runFindDependents(
  binaryPath: string,
  workspacePath: string,
  swiftFiles: string[],
  targetId: string
): Promise<Record<string, string[]>> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ["--workspace", workspacePath, "--find-dependents-of", targetId, ...swiftFiles], { stdio: ["ignore", "pipe", "pipe"] });
    const bufs: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => bufs.push(c));
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("error", (e) => reject(new AnalyzerError(e.message, stderr)));
    child.on("close", (code) => {
      if (code !== 0) { reject(new AnalyzerError(extractErr(stderr) || `Dependents failed (${code})`, stderr)); return; }
      try { resolve(JSON.parse(Buffer.concat(bufs).toString("utf-8"))); }
      catch { reject(new AnalyzerError("Parse failed", stderr)); }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// STDERR
// ═══════════════════════════════════════════════════════════════════════════════

function parseStderr(text: string, cb: AnalyzerCallbacks) {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const m = JSON.parse(t);
      if (m._progress) cb.onProgress(m._progress as ProgressInfo);
      else if (m._warning) cb.onWarning(m._warning);
    } catch { /* skip */ }
  }
}

function extractErr(stderr: string): string | null {
  for (const line of stderr.split("\n").reverse()) {
    const t = line.trim();
    if (!t) continue;
    try { const m = JSON.parse(t); if (m._error) return String(m._error); } catch { /* skip */ }
  }
  return null;
}
