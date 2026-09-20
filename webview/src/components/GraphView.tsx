import { useRef, useEffect, useCallback, useState, useMemo } from "react";
import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import * as THREE from "three";
import type { AnalysisResult, PrismNode, PrismLink, LinkType, FilePreview, CallSiteRef } from "../protocol";
import { NodeDetailCard } from "./NodeDetailCard";
import {
  nodeColor,
  nodeShape,
  nodeSize,
  resourceColor,
  resourceShape,
  resourceSize,
  linkColor,
  linkWidth,
  type NodeShape,
} from "../design/theme";

interface GraphViewProps {
  result: AnalysisResult | null;
  highlightedIds?: Set<string>;
  onCopyContext?: (nodeId: string) => void;
  onOpenFile?: (location: { file: string; line: number; col: number }) => void;
  onRequestMembers?: (nodeId: string) => void;
  onRequestFilePreview?: (nodeId: string, filePath: string) => void;
  onClearPreview?: () => void;
  filePreview?: FilePreview | null;
  /** Node IDs currently awaiting semantic context from the LLM */
  pendingContextIds?: Set<string>;
  /** Resolved semantic contexts keyed by node ID */
  nodeContextMap?: Map<string, string>;
}

interface GraphNode {
  id: string;
  name: string;
  flavor: PrismNode["flavor"] | "resource" | "module" | "file";
  subKind: PrismNode["subKind"];
  isStatic: boolean;
  color: string;
  shape: NodeShape;
  size: number;
  isHighlighted: boolean;
  isTopLevel: boolean;
  isModule: boolean;
  isMacroModule: boolean;
  isGlobal: boolean;
  isFileNode: boolean;
  isInteresting: boolean;
  isProtocolRequirement: boolean;
  isTargetHub: boolean;
  hidden: boolean;
  parentId: string | null;
  parentFile: string | null;
  fileNodeId: string | null;
  sourceFile: string;
  memberCount: number | null;
  targetName: string | null;
  origin: string | null;
  location: { file: string; line: number; column: number };
  x?: number;
  y?: number;
  z?: number;
  fx?: number | undefined;
  fy?: number | undefined;
  fz?: number | undefined;
  __threeObj?: THREE.Object3D;
}

interface GraphLink {
  source: string;
  target: string;
  linkType: PrismLink["type"] | "file_containment" | "resource_containment";
  color: string;
  width: number;
  hidden?: boolean;
  references?: CallSiteRef[] | null;
}

const TOP_LEVEL_FLAVORS = new Set(["struct", "class", "enum", "actor", "protocol", "target"]);
const COLLAPSE_THRESHOLD = 150;
const GLOBAL_COLOR = "#90A4AE";
const FILE_NODE_COLOR = "#546E7A";
const FILE_LINK_COLOR = "rgba(144,164,174,0.25)";
const ORBIT_RADIUS = 25;

// Target hub colors by origin category
const TARGET_COLOR_APPLE = "#42A5F5";     // Blue — Apple SDK
const TARGET_COLOR_REMOTE = "#FF9800";    // Orange — Remote Git
const TARGET_COLOR_LOCAL = "#66BB6A";     // Green — Local External
const TARGET_COLOR_INTERNAL = "#80DEEA";  // Cyan — Internal project target
const ENTRY_POINT_COLOR = "#FFD700";      // Gold — GLOBAL::MAIN

function targetColorByOrigin(origin: string | null): string {
  if (!origin) return TARGET_COLOR_INTERNAL;
  if (origin === "Apple") return TARGET_COLOR_APPLE;
  if (origin.startsWith("http://") || origin.startsWith("https://") || origin.endsWith(".git")) return TARGET_COLOR_REMOTE;
  if (origin.startsWith("/")) return TARGET_COLOR_LOCAL;
  return TARGET_COLOR_INTERNAL;
}

const LINK_TYPE_LABELS: Record<LinkType, string> = {
  call: "Calls",
  access: "Access",
  conformance: "Conformance",
  inheritance: "Inheritance",
  observer_trigger: "Observers",
  resource_link: "Resources",
  resource_alias: "Aliases",
  heuristic_link: "Heuristic",
  cross_target_dependency: "Cross-target",
  macro_expansion: "Macros",
  extension_contribution: "Extensions",
  nesting: "Nesting",
  environment_injection: "Env Injection",
  environment_provider: "Env Provider",
  holds_type: "Stores",
  enum_usage: "Uses Enum",
  import_dependency: "Imports",
};

const SHAPE_GLYPHS: Record<NodeShape, string> = {
  sphere: "\u25CF",
  box: "\u25A0",
  diamond: "\u25C6",
  "mini-sphere": "\u2022",
  cylinder: "\u2B24",
  cone: "\u25B2",
  torus: "\u25CE",
  "large-box": "\u2B1B",
};

const LOD_NEAR = 300;
const LOD_FAR = 800;

interface SimConfig {
  warmupTicks: number;
  cooldownTicks: number;
  alphaDecay: number;
  velocityDecay: number;
  chargeStrength: number;
  linkDistance: number;
  centerStrength: number;
}

function computeSimConfig(nodeCount: number): SimConfig {
  if (nodeCount <= 50) {
    return { warmupTicks: 30, cooldownTicks: 150, alphaDecay: 0.04, velocityDecay: 0.25, chargeStrength: -120, linkDistance: 40, centerStrength: 0.05 };
  }
  if (nodeCount <= 200) {
    return { warmupTicks: 80, cooldownTicks: 250, alphaDecay: 0.035, velocityDecay: 0.35, chargeStrength: -80, linkDistance: 55, centerStrength: 0.08 };
  }
  if (nodeCount <= 500) {
    return { warmupTicks: 120, cooldownTicks: 300, alphaDecay: 0.03, velocityDecay: 0.4, chargeStrength: -50, linkDistance: 70, centerStrength: 0.12 };
  }
  const clampedCount = Math.min(nodeCount, 5000);
  const t = (clampedCount - 500) / 4500;
  return {
    warmupTicks: Math.round(150 + t * 100),
    cooldownTicks: Math.round(300 + t * 200),
    alphaDecay: 0.025 - t * 0.01,
    velocityDecay: 0.45 + t * 0.15,
    chargeStrength: -30 + t * 20,
    linkDistance: 80 + t * 40,
    centerStrength: 0.15 + t * 0.15,
  };
}

const MODULE_COLORS: Record<string, string> = {
  library: "#5C6BC0",
  executable: "#66BB6A",
  test: "#FF7043",
  macro: "#FF5252",
  plugin: "#78909C",
  unknown: "#BDBDBD",
};

function buildFullNodeList(
  result: AnalysisResult,
  highlightedIds: Set<string>
): GraphNode[] {
  const moduleIds = new Set((result.moduleNodes ?? []).map((m) => m.id));

  const fileGlobalCounts = new Map<string, number>();
  let skippedNoId = 0;
  for (const n of result.nodes) {
    if (!n.id) { skippedNoId++; continue; }
    if (n.isGlobal && n.parentFile) {
      fileGlobalCounts.set(n.parentFile, (fileGlobalCounts.get(n.parentFile) ?? 0) + 1);
    }
  }
  if (skippedNoId > 0) {
    console.error(`[SwiftPrism] ${skippedNoId} nodes skipped: missing id field`);
  }

  const nodes: GraphNode[] = [];

  for (const fileName of fileGlobalCounts.keys()) {
    const fileNodeId = `file:${fileName}`;
    const sampleNode = result.nodes.find((n) => n.parentFile === fileName);
    nodes.push({
      id: fileNodeId,
      name: fileName,
      flavor: "file",
      subKind: null,
      isStatic: false,
      color: FILE_NODE_COLOR,
      shape: "torus",
      size: 6,
      isHighlighted: false,
      isTopLevel: true,
      isModule: false,
      isMacroModule: false,
      isGlobal: false,
      isFileNode: true, isInteresting: true, isProtocolRequirement: false,
      isTargetHub: false,
      hidden: false,
      parentId: null,
      parentFile: null,
      fileNodeId: null,
      sourceFile: fileName,
      memberCount: fileGlobalCounts.get(fileName) ?? 0,
      targetName: sampleNode?.targetName ?? null,
      origin: null,
      location: { file: sampleNode?.location.file ?? "", line: 1, column: 1 },
    });
  }

  for (const n of result.nodes) {
    // Execution-First: stored properties never become graph nodes
    if (n.flavor === "variable" && (n.subKind === "stored" || n.subKind === null)) continue;

    const isTarget = n.flavor === "target";
    const isModule = !isTarget && moduleIds.has(n.id);
    const moduleInfo = isModule ? (result.moduleNodes ?? []).find((m) => m.id === n.id) : null;
    const fileNodeId = n.isGlobal && n.parentFile ? `file:${n.parentFile}` : null;

    const isEntryPoint = n.flavor === "entry_point";
    const targetOrigin = isTarget ? (n.origin ?? null) : null;

    nodes.push({
      id: n.id,
      name: n.name,
      flavor: isModule ? "module" : n.flavor,
      subKind: n.subKind,
      isStatic: n.isStatic,
      color: isTarget ? targetColorByOrigin(targetOrigin)
        : isEntryPoint ? ENTRY_POINT_COLOR
        : n.isGlobal ? GLOBAL_COLOR
        : isModule ? (MODULE_COLORS[moduleInfo?.moduleType ?? "library"] ?? MODULE_COLORS.library)
        : nodeColor(n.flavor, n.subKind),
      shape: isTarget ? "large-box" : n.isGlobal ? "mini-sphere" : isModule ? "large-box" : nodeShape(n.flavor, n.subKind, n.isStatic),
      size: isTarget ? nodeSize("target", null) : isEntryPoint ? 14 : n.isGlobal ? 2.5 : isModule ? 15 : nodeSize(n.flavor, n.subKind),
      isHighlighted: highlightedIds.has(n.id) || highlightedIds.has(n.name),
      isTopLevel: isTarget || isEntryPoint || isModule || (!n.isGlobal && TOP_LEVEL_FLAVORS.has(n.flavor)),
      isModule: isModule || isTarget,
      isMacroModule: moduleInfo?.isMacro ?? false,
      isGlobal: n.isGlobal,
      isFileNode: false, isInteresting: true, isProtocolRequirement: n.isProtocolRequirement ?? false,
      isTargetHub: isTarget,
      hidden: false,
      parentId: isTarget ? null : n.parent,
      parentFile: isTarget ? null : (n.parentFile ?? null),
      fileNodeId: isTarget ? null : fileNodeId,
      sourceFile: n.sourceFile,
      memberCount: n.memberCount ?? null,
      targetName: isTarget ? n.id : (n.targetName ?? null),
      origin: targetOrigin,
      location: n.location,
    });
  }

  if (result.resources) {
    for (const r of result.resources) {
      const isGroupParent = !r.parentGroup;
      const isChild = !!r.parentGroup;
      nodes.push({
        id: r.id,
        name: r.name,
        flavor: "resource",
        subKind: null,
        isStatic: false,
        color: resourceColor(r.resourceType),
        shape: isGroupParent ? resourceShape(r.resourceType) : resourceShape(r.resourceType),
        size: isChild ? resourceSize(r.resourceType) : resourceSize(r.resourceType),
        isHighlighted: highlightedIds.has(r.id) || highlightedIds.has(r.name),
        isTopLevel: isGroupParent,
        isModule: false,
        isMacroModule: false,
        isGlobal: false,
        isFileNode: false, isInteresting: true, isProtocolRequirement: false,
        isTargetHub: false,
        hidden: false,
        parentId: r.parentGroup,
        parentFile: null,
        fileNodeId: r.parentGroup,
        sourceFile: r.filePath,
        memberCount: null,
        targetName: null,
        origin: null,
        location: { file: r.filePath, line: 1, column: 1 },
      });
    }
  }

  console.log(`[SwiftPrism] buildFullNodeList: ${result.nodes.length} code nodes + ${result.resources?.length ?? 0} resources + ${fileGlobalCounts.size} file groups = ${nodes.length} graph nodes`);
  return nodes;
}

function computeVisibility(
  allNodes: GraphNode[],
  expandedParents: Set<string>,
  collapsed: boolean
): Set<string> {
  const visible = new Set<string>();
  if (!collapsed) {
    for (const n of allNodes) {
      // Defense-in-depth: skip any stored variables that leaked through
      if (n.flavor === "variable" && (n.subKind === "stored" || n.subKind === null)) continue;
      visible.add(n.id);
    }
    return visible;
  }
  for (const n of allNodes) {
    if (n.isTopLevel || n.isFileNode) {
      visible.add(n.id);
    } else if (n.isGlobal && n.fileNodeId) {
      visible.add(n.id);
    } else if (n.parentId && expandedParents.has(n.parentId)) {
      visible.add(n.id);
    } else if (n.isHighlighted) {
      visible.add(n.id);
    }
  }
  return visible;
}

/**
 * Resolve a call target ID to the best matching graph node.
 * Hierarchical calls use Target::File::Object::Member IDs which may not match
 * flat graph node IDs directly. Walk up the :: segments to find the nearest parent.
 */
function resolveCallTargetToGraphNode(
  callTarget: string,
  allNodeIds: Set<string>,
  nodeById: Map<string, GraphNode>
): string | null {
  // Direct match
  if (allNodeIds.has(callTarget)) return callTarget;

  // Strip segments from the right to find nearest parent
  const parts = callTarget.split("::");
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidate = parts.slice(0, i).join("::");
    if (allNodeIds.has(candidate)) return candidate;
  }

  // Try matching by name (last segment) — handles flat IDs like "ClassName.methodName"
  const leafName = parts[parts.length - 1];
  for (const [id, node] of nodeById) {
    if (node.name === leafName || id.endsWith(`.${leafName}`) || id.endsWith(`::${leafName}`)) {
      return id;
    }
  }

  return null;
}

function buildFullGraphData(
  allNodes: GraphNode[],
  result: AnalysisResult,
  visibleLinkTypes: Set<LinkType>,
  visibleNodeIds: Set<string>,
  showStructural: boolean = true
): { nodes: GraphNode[]; links: GraphLink[] } {
  const allNodeIds = new Set(allNodes.map((n) => n.id));
  const nodeById = new Map(allNodes.map((n) => [n.id, n]));

  const nodes = allNodes.map((n) => ({
    ...n,
    hidden: !visibleNodeIds.has(n.id),
  }));

  const links: GraphLink[] = [];
  const seenLinks = new Set<string>();

  const resolveVisibleAncestor = (id: string): string | null => {
    if (visibleNodeIds.has(id)) return id;
    const node = nodeById.get(id);
    if (!node) return null;
    if (node.parentId && allNodeIds.has(node.parentId)) return resolveVisibleAncestor(node.parentId);
    if (node.fileNodeId && allNodeIds.has(node.fileNodeId)) return resolveVisibleAncestor(node.fileNodeId);
    return null;
  };

  const addLink = (
    source: string,
    target: string,
    type: GraphLink["linkType"],
    refs?: GraphLink["references"]
  ) => {
    let effectiveSource = source;
    let effectiveTarget = target;

    if (!visibleNodeIds.has(effectiveSource)) {
      const ancestor = resolveVisibleAncestor(effectiveSource);
      if (ancestor) effectiveSource = ancestor;
    }
    if (!visibleNodeIds.has(effectiveTarget)) {
      const ancestor = resolveVisibleAncestor(effectiveTarget);
      if (ancestor) effectiveTarget = ancestor;
    }

    if (effectiveSource === effectiveTarget) return;
    if (!allNodeIds.has(effectiveSource) || !allNodeIds.has(effectiveTarget)) return;

    const isStructural = type === "nesting";
    const typeVisible = (visibleLinkTypes.has(type as LinkType) || isStructural);
    const visible = typeVisible && visibleNodeIds.has(effectiveSource) && visibleNodeIds.has(effectiveTarget);

    const key = `${effectiveSource}->${effectiveTarget}:${type}`;
    if (seenLinks.has(key)) return;
    seenLinks.add(key);

    links.push({
      source: effectiveSource,
      target: effectiveTarget,
      linkType: type,
      color: linkColor(type as LinkType),
      width: isStructural ? 3 : linkWidth(type as LinkType),
      hidden: !visible,
      references: refs,
    });
  };

  // ─── Pass 1: Links from flat result.links (backward-compatible) ───
  let brokenCount = 0;
  for (const l of result.links) {
    if (!allNodeIds.has(l.source_id) || !allNodeIds.has(l.target_id)) {
      brokenCount++;
      continue;
    }
    addLink(l.source_id, l.target_id, l.type, l.references);
  }

  if (brokenCount > 0) {
    console.warn(`[SwiftPrism] ${brokenCount} links dropped: source or target not in graph`);
  }

  // ─── Pass 2: Recover broken links via parent-ID fallback ───
  // Links where source or target wasn't found in the graph (brokenCount from Pass 1).
  // Use resolveCallTargetToGraphNode to walk up the :: namespace and find the
  // nearest ancestor that IS in the graph.
  let recoveredCount = 0;
  for (const l of result.links) {
    const srcInGraph = allNodeIds.has(l.source_id);
    const tgtInGraph = allNodeIds.has(l.target_id);
    if (srcInGraph && tgtInGraph) continue; // already handled in Pass 1

    const resolvedSrc = srcInGraph
      ? l.source_id
      : resolveCallTargetToGraphNode(l.source_id, allNodeIds, nodeById);
    const resolvedTgt = tgtInGraph
      ? l.target_id
      : resolveCallTargetToGraphNode(l.target_id, allNodeIds, nodeById);

    if (resolvedSrc && resolvedTgt && resolvedSrc !== resolvedTgt) {
      addLink(resolvedSrc, resolvedTgt, l.type, l.references);
      recoveredCount++;
    }
  }

  if (recoveredCount > 0) {
    console.info(`[SwiftPrism] ${recoveredCount} links recovered via parent-ID fallback`);
  }

  // ─── Pass 3: Nesting links from parents[] ancestry ───
  // Every node with a parentId gets a nesting link to its parent.
  // This is the hierarchical parent→child relationship from the scope stack.
  let nestingCount = 0;
  for (const n of allNodes) {
    if (n.parentId && allNodeIds.has(n.parentId) && n.parentId !== n.id) {
      const key = `${n.parentId}->${n.id}:nesting`;
      if (!seenLinks.has(key)) {
        addLink(n.parentId, n.id, "nesting");
        nestingCount++;
      }
    }
  }

  // ─── Pass 4: Structural links (file→object, resource containment) ───
  // File→Object links are a secondary "Structural" layer, togglable via showStructural.
  // Object→Member links (nesting) are always shown since they're execution-primary.
  if (showStructural) {
    for (const n of allNodes) {
      if (n.isGlobal && n.fileNodeId && allNodeIds.has(n.fileNodeId)) {
        addLink(n.fileNodeId, n.id, "file_containment");
      }
      if (n.isFileNode && n.parentId === null) {
        const childObjects = allNodes.filter((c) => c.parentFile === n.name && !c.parentId && !c.isGlobal && allNodeIds.has(c.id));
        for (const child of childObjects) {
          addLink(n.id, child.id, "file_containment");
        }
      }
    }
  }
  for (const n of allNodes) {
    if (n.flavor === "resource" && n.parentId && allNodeIds.has(n.parentId)) {
      addLink(n.parentId, n.id, "resource_containment");
    }
  }

  if (nestingCount > 0) {
    console.info(`[SwiftPrism] ${nestingCount} nesting links from parents[] ancestry`);
  }
  console.log("CORE: Hierarchical Analyzer Activated");

  return { nodes, links };
}

function childCountForParent(parentId: string, allNodes: GraphNode[]): number {
  let count = 0;
  for (const n of allNodes) {
    if (n.parentId === parentId && !n.isTopLevel) count++;
  }
  return count;
}

const spriteCache = new Map<string, THREE.SpriteMaterial>();
const dotCache = new Map<string, THREE.SpriteMaterial>();

function buildSpriteKey(n: GraphNode, lod: "full" | "dot"): string {
  return `${lod}|${n.color}|${n.shape}|${n.size}|${n.isHighlighted ? 1 : 0}|${n.isGlobal ? "g" : ""}|${n.isFileNode ? "f" : ""}|${n.isProtocolRequirement ? "pr" : ""}|${lod === "full" ? n.name.slice(0, 20) : ""}`;
}

function createSpriteTexture(n: GraphNode, lod: "full" | "dot"): THREE.SpriteMaterial {
  const cache = lod === "full" ? spriteCache : dotCache;
  const key = buildSpriteKey(n, lod);
  const cached = cache.get(key);
  if (cached) return cached;

  const res = lod === "full" ? 128 : 32;
  const canvas = document.createElement("canvas");
  canvas.width = res;
  canvas.height = res;
  const ctx = canvas.getContext("2d")!;

  if (lod === "dot") {
    ctx.beginPath();
    ctx.arc(res / 2, res / 2, res / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.globalAlpha = n.isGlobal ? 0.5 : n.isHighlighted ? 1 : 0.8;
    ctx.fill();
  } else {
    if (n.isProtocolRequirement) {
      ctx.beginPath();
      ctx.arc(res / 2, res / 2, res / 2 - 4, 0, Math.PI * 2);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = n.color;
      ctx.lineWidth = 2;
      ctx.globalAlpha = 0.6;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    } else if (n.isHighlighted) {
      ctx.beginPath();
      ctx.arc(res / 2, res / 2, res / 2 - 2, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.globalAlpha = 0.15;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    const glyph = SHAPE_GLYPHS[n.shape] || SHAPE_GLYPHS.sphere;
    const glyphSize = n.isGlobal ? 24 : n.isFileNode ? 32 : Math.min(n.size * 7, 64);
    ctx.font = `${glyphSize}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = n.isHighlighted ? "#FFFFFF" : n.color;
    ctx.globalAlpha = n.isGlobal ? 0.7 : 1;
    ctx.fillText(glyph, res / 2, res / 2 - (n.isGlobal ? 0 : 8));
    ctx.globalAlpha = 1;

    if (!n.isGlobal) {
      const label = n.name.length > 12 ? n.name.slice(0, 11) + "\u2026" : n.name;
      const labelSize = n.isFileNode ? 11 : Math.max(10, Math.min(14, 128 / label.length));
      ctx.font = `bold ${labelSize}px sans-serif`;
      ctx.fillStyle = n.isHighlighted ? "#FFFFFF" : "rgba(255,255,255,0.85)";
      ctx.fillText(label, res / 2, res / 2 + glyphSize / 2 + 6);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
  });

  if (cache.size > 2000) {
    const firstKey = cache.keys().next().value;
    if (firstKey) { cache.get(firstKey)?.dispose(); cache.delete(firstKey); }
  }
  cache.set(key, material);
  return material;
}

function createNodeSprite(n: GraphNode): THREE.Group {
  const group = new THREE.Group();

  // Target hubs and entry points always render full, not dots
  const useDot = n.isGlobal && !n.isTargetHub && n.flavor !== "entry_point";
  const material = createSpriteTexture(n, useDot ? "dot" : "full");
  const sprite = new THREE.Sprite(material);
  const scale = useDot ? n.size * 1.2 : n.size * 1.8;
  sprite.scale.set(scale, scale, 1);
  group.add(sprite);

  // Entry point: add a subtle glow ring
  if (n.flavor === "entry_point") {
    const glowCanvas = document.createElement("canvas");
    glowCanvas.width = 64;
    glowCanvas.height = 64;
    const gctx = glowCanvas.getContext("2d")!;
    const gradient = gctx.createRadialGradient(32, 32, 8, 32, 32, 30);
    gradient.addColorStop(0, "rgba(255, 215, 0, 0.5)");
    gradient.addColorStop(1, "rgba(255, 215, 0, 0)");
    gctx.fillStyle = gradient;
    gctx.fillRect(0, 0, 64, 64);
    const glowTex = new THREE.CanvasTexture(glowCanvas);
    glowTex.minFilter = THREE.LinearFilter;
    const glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, sizeAttenuation: true });
    const glowSprite = new THREE.Sprite(glowMat);
    glowSprite.scale.set(scale * 2.5, scale * 2.5, 1);
    group.add(glowSprite);
  }

  const hitRadius = Math.max(scale * 1.5, 6);
  const hitGeo = new THREE.SphereGeometry(hitRadius, 6, 4);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hitMesh = new THREE.Mesh(hitGeo, hitMat);
  group.add(hitMesh);

  group.userData = {
    currentLod: useDot ? "dot" : "full",
    baseScale: scale,
    sprite,
  };
  return group;
}

function highlightNeighbors(nodeId: string, graph: ForceGraph3DInstance) {
  const data = graph.graphData();
  const neighborIds = new Set<string>();
  for (const l of data.links as GraphLink[]) {
    const src = typeof l.source === "object" ? (l.source as GraphNode).id : l.source;
    const tgt = typeof l.target === "object" ? (l.target as GraphNode).id : l.target;
    if (src === nodeId) neighborIds.add(tgt);
    if (tgt === nodeId) neighborIds.add(src);
  }
  for (const n of data.nodes as GraphNode[]) {
    if (!neighborIds.has(n.id)) continue;
    const g = n.__threeObj as THREE.Group | undefined;
    if (g?.userData?.sprite) {
      const s = g.userData.baseScale * 1.2;
      g.userData.sprite.scale.set(s, s, 1);
    }
  }
}

function restoreNeighborHighlight(nodeId: string, graph: ForceGraph3DInstance) {
  const data = graph.graphData();
  const neighborIds = new Set<string>();
  for (const l of data.links as GraphLink[]) {
    const src = typeof l.source === "object" ? (l.source as GraphNode).id : l.source;
    const tgt = typeof l.target === "object" ? (l.target as GraphNode).id : l.target;
    if (src === nodeId) neighborIds.add(tgt);
    if (tgt === nodeId) neighborIds.add(src);
  }
  for (const n of data.nodes as GraphNode[]) {
    if (!neighborIds.has(n.id)) continue;
    const g = n.__threeObj as THREE.Group | undefined;
    if (g?.userData?.sprite) {
      const s = g.userData.baseScale;
      g.userData.sprite.scale.set(s, s, 1);
    }
  }
}

function FilterPanel({
  linkTypes, visibleLinkTypes, onToggle, collapsed, onToggleCollapse, totalNodes, visibleNodes,
  showStructural, onToggleStructural,
}: {
  linkTypes: LinkType[]; visibleLinkTypes: Set<LinkType>; onToggle: (type: LinkType) => void;
  collapsed: boolean; onToggleCollapse: () => void; totalNodes: number; visibleNodes: number;
  showStructural: boolean; onToggleStructural: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={filterStyles.wrapper}>
      <button style={filterStyles.toggle} onClick={() => setOpen(!open)}>
        {open ? "\u2715" : "\u2699"}
      </button>
      {open && (
        <div style={filterStyles.panel}>
          <div style={filterStyles.section}>
            <span style={filterStyles.label}>Execution</span>
            {linkTypes.map((lt) => (
              <label key={lt} style={filterStyles.row}>
                <input type="checkbox" checked={visibleLinkTypes.has(lt)} onChange={() => onToggle(lt)} style={filterStyles.checkbox} />
                <span style={{ color: linkColor(lt) }}>{LINK_TYPE_LABELS[lt] || lt}</span>
              </label>
            ))}
          </div>
          <div style={filterStyles.section}>
            <span style={filterStyles.label}>Structural</span>
            <label style={filterStyles.row}>
              <input type="checkbox" checked={showStructural} onChange={onToggleStructural} style={filterStyles.checkbox} />
              <span style={{ color: FILE_NODE_COLOR }}>File → Object</span>
            </label>
          </div>
          {totalNodes > COLLAPSE_THRESHOLD && (
            <div style={filterStyles.section}>
              <span style={filterStyles.label}>Hierarchy</span>
              <label style={filterStyles.row}>
                <input type="checkbox" checked={collapsed} onChange={onToggleCollapse} style={filterStyles.checkbox} />
                <span>Top-level only</span>
              </label>
              <span style={filterStyles.count}>{visibleNodes}/{totalNodes} nodes</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function GraphView({ result, highlightedIds = new Set(), onCopyContext, onOpenFile, onRequestMembers, onRequestFilePreview, onClearPreview, filePreview, pendingContextIds = new Set(), nodeContextMap = new Map() }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraph3DInstance | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [visibleLinkTypes, setVisibleLinkTypes] = useState<Set<LinkType>>(() => new Set(Object.keys(LINK_TYPE_LABELS) as LinkType[]));
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState(false);
  const [showStructural, setShowStructural] = useState(true);
  const animFrameRef = useRef<number>(0);
  const lastClickRef = useRef<{ id: string; time: number }>({ id: "", time: 0 });
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredNodeInfo, setHoveredNodeInfo] = useState<{
    id: string; name: string; flavor: string; subKind: string | null;
    isStatic: boolean; isGlobal: boolean; isModule: boolean;
    parentId: string | null; sourceFile: string; memberCount: number | null; color: string;
    targetName: string | null;
    locations?: { file: string; line: number; column: number }[];
    origin?: string;
    semanticContext?: string | null;
    contextPending?: boolean;
  } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardHoveredRef = useRef(false);
  const [cardPinned, setCardPinned] = useState(false);
  const initialLoadDone = useRef(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [clickedLink, setClickedLink] = useState<GraphLink | null>(null);
  const [linkMenuPos, setLinkMenuPos] = useState<{ x: number; y: number } | null>(null);
  const keysPressed = useRef(new Set<string>());
  const keyAnimRef = useRef<number>(0);
  const allNodesRef = useRef<GraphNode[]>([]);
  const collapsedRef = useRef(false);
  const expandedParentsRef = useRef<Set<string>>(new Set());
  const expandedModulesRef = useRef<Set<string>>(new Set());

  const [schemaError, setSchemaError] = useState<string | null>(null);

  const allNodes = useMemo(() => {
    if (!result) return [];
    const hasLegacy = result.nodes.some((n: any) => "connections" in n);
    if (hasLegacy) {
      console.error("[SwiftPrism] CRITICAL: Old Schema Detected. Aborting Render.");
      setSchemaError("System Reset Required: Old Data Format Found. Re-run analysis with v4.0.");
      return [];
    }
    setSchemaError(null);
    return buildFullNodeList(result, highlightedIds);
  }, [result, highlightedIds]);

  useEffect(() => { allNodesRef.current = allNodes; }, [allNodes]);
  useEffect(() => { collapsedRef.current = collapsed; }, [collapsed]);
  useEffect(() => { expandedParentsRef.current = expandedParents; }, [expandedParents]);
  useEffect(() => { expandedModulesRef.current = expandedModules; }, [expandedModules]);

  const shouldAutoCollapse = allNodes.length > COLLAPSE_THRESHOLD;
  useEffect(() => {
    if (shouldAutoCollapse && allNodes.length > 0) setCollapsed(true);
  }, [shouldAutoCollapse, allNodes.length]);

  const presentLinkTypes = useMemo<LinkType[]>(() => {
    if (!result) return [];
    const types = new Set<LinkType>();
    for (const l of result.links) types.add(l.type);
    return Array.from(types).sort();
  }, [result]);

  const visibleNodeIds = useMemo(() => {
    const vis = computeVisibility(allNodes, expandedParents, collapsed);
    if (vis.size === 0 && allNodes.length > 0) {
      console.warn(`[SwiftPrism] Visibility computed 0 visible nodes out of ${allNodes.length} — showing all`);
      return new Set(allNodes.map((n) => n.id));
    }
    return vis;
  }, [allNodes, expandedParents, collapsed]);

  const graphData = useMemo(() => {
    if (!result) return { nodes: [] as GraphNode[], links: [] as GraphLink[] };
    // Safety net: exclude any stored variables that survived earlier filters
    const execNodes = allNodes.filter((n) =>
      n.flavor !== "variable" || (n.subKind !== null && n.subKind !== "stored")
    );
    return buildFullGraphData(execNodes, result, visibleLinkTypes, visibleNodeIds, showStructural);
  }, [allNodes, result, visibleLinkTypes, visibleNodeIds, showStructural]);


  const handleToggleLink = useCallback((type: LinkType) => {
    setVisibleLinkTypes((prev) => { const next = new Set(prev); if (next.has(type)) next.delete(type); else next.add(type); return next; });
  }, []);

  const handleToggleCollapse = useCallback(() => {
    setCollapsed((prev) => { if (prev) setExpandedParents(new Set()); return !prev; });
  }, []);

  const flyToNode = useCallback((node: GraphNode) => {
    if (!graphRef.current) return;
    const dist = node.size * 12;
    graphRef.current.cameraPosition(
      { x: (node.x ?? 0) + dist, y: (node.y ?? 0) + dist * 0.3, z: (node.z ?? 0) + dist },
      { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 },
      800
    );
  }, []);

  const resetCamera = useCallback(() => {
    if (!graphRef.current) return;
    graphRef.current.zoomToFit(600, 60);
  }, []);

  const handleNodeClick = useCallback(
    (node: unknown) => {
      const n = node as GraphNode;
      const now = Date.now();
      const isDoubleClick = lastClickRef.current.id === n.id && now - lastClickRef.current.time < 400;
      lastClickRef.current = { id: n.id, time: now };

      if (n.isFileNode) {
        setSelectedNode(n);
        return;
      }

      // Target hubs: fly-to and show detail (no member expansion)
      if (n.isTargetHub) {
        setSelectedNode(n);
        flyToNode(n);
        return;
      }

      if (n.isModule) {
        if (isDoubleClick && onRequestMembers && !n.isMacroModule) {
          if (expandedModulesRef.current.has(n.id)) {
            setExpandedModules((prev) => { const next = new Set(prev); next.delete(n.id); return next; });
          } else {
            onRequestMembers(n.id.replace("module:", ""));
            setExpandedModules((prev) => new Set(prev).add(n.id));
          }
          return;
        }
        setSelectedNode(n);
        return;
      }

      if (collapsedRef.current && n.isTopLevel) {
        const localChildren = childCountForParent(n.id, allNodesRef.current);
        if (localChildren > 0) {
          setExpandedParents((prev) => { const next = new Set(prev); if (next.has(n.id)) next.delete(n.id); else next.add(n.id); return next; });
          return;
        }
        if (localChildren === 0 && n.memberCount && n.memberCount > 0 && onRequestMembers) {
          onRequestMembers(n.id);
          setExpandedParents((prev) => new Set(prev).add(n.id));
          return;
        }
      }

      if (!collapsedRef.current && n.isTopLevel && n.memberCount && n.memberCount > 0) {
        const localChildren = childCountForParent(n.id, allNodesRef.current);
        if (localChildren === 0 && onRequestMembers) {
          onRequestMembers(n.id);
          setSelectedNode(n);
          return;
        }
      }

      setSelectedNode(n);
      flyToNode(n);
      if (onOpenFile && n.location.file) {
        onOpenFile({ file: n.location.file, line: n.location.line, col: n.location.column });
      }
    },
    [onOpenFile, onRequestMembers, flyToNode]
  );

  const initGraph = useCallback(() => {
    if (!containerRef.current) return;
    if (graphRef.current) { cancelAnimationFrame(animFrameRef.current); graphRef.current._destructor(); graphRef.current = null; }

    const nodeCount = allNodesRef.current.length;
    const sim = computeSimConfig(nodeCount);
    initialLoadDone.current = false;

    const graph = new ForceGraph3D(containerRef.current)
      .backgroundColor("rgba(0,0,0,0)")
      .showNavInfo(false)
      .nodeThreeObject((node: unknown) => createNodeSprite(node as GraphNode))
      .nodeThreeObjectExtend(false)
      .nodeVisibility((node: unknown) => !(node as GraphNode).hidden)
      .linkVisibility((link: unknown) => !(link as GraphLink).hidden)
      .nodeLabel((node: unknown) => {
        const n = node as GraphNode;
        if (n.isFileNode) return `${n.name} (${n.memberCount ?? 0} globals)`;
        if (n.isModule) {
          const memberStr = n.memberCount ? ` (${n.memberCount} symbols)` : "";
          return `${n.name}${n.isMacroModule ? " [macro]" : ""}${memberStr} \u2014 double-click to expand`;
        }
        if (n.isGlobal) return `${n.name} [${n.flavor}] in ${n.parentFile ?? "?"}`;
        const parts = [n.name];
        if (n.subKind) parts.push(`(${n.subKind})`);
        parts.push(`[${n.flavor}]`);
        if (n.isStatic) parts.push("static");
        const localChildren = childCountForParent(n.id, allNodesRef.current);
        const totalMembers = localChildren || n.memberCount || 0;
        if (n.isTopLevel && totalMembers > 0) {
          const expanded = localChildren > 0 && expandedParentsRef.current.has(n.id);
          if (collapsedRef.current) parts.push(expanded ? `[-${totalMembers}]` : `[+${totalMembers}]`);
          else if (localChildren === 0) parts.push(`[+${totalMembers}]`);
        }
        return parts.join(" ");
      })
      .onNodeClick(handleNodeClick)
      .onNodeHover((node: unknown, prevNode: unknown) => {
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
        if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }

        if (prevNode) {
          const prev = prevNode as GraphNode;
          const prevGroup = prev.__threeObj as THREE.Group | undefined;
          if (prevGroup?.userData?.sprite) {
            const base = prevGroup.userData.baseScale;
            prevGroup.userData.sprite.scale.set(base, base, 1);
          }
          restoreNeighborHighlight(prev.id, graph);
        }

        if (!node) {
          // Delayed hide: give user 150ms to move mouse into the card
          hideTimerRef.current = setTimeout(() => {
            if (!cardHoveredRef.current) {
              setHoveredNodeId(null);
              setHoveredNodeInfo(null);
              setHoverPos(null);
              setCardPinned(false);
              onClearPreview?.();
            }
          }, 150);
          return;
        }
        const n = node as GraphNode;

        const group = n.__threeObj as THREE.Group | undefined;
        if (group?.userData?.sprite) {
          const hoverScale = group.userData.baseScale * 1.5;
          group.userData.sprite.scale.set(hoverScale, hoverScale, 1);
        }
        highlightNeighbors(n.id, graph);

        const screen = graph.graph2ScreenCoords(n.x ?? 0, n.y ?? 0, n.z ?? 0);
        setHoverPos({ x: screen.x, y: screen.y });
        setHoveredNodeId(n.id);
        setCardPinned(true);
        const prismNode = result?.nodes.find((pn) => pn.id === n.id);
        setHoveredNodeInfo({
          id: n.id, name: n.name, flavor: n.flavor, subKind: n.subKind,
          isStatic: n.isStatic, isGlobal: n.isGlobal, isModule: n.isModule,
          parentId: n.parentId, sourceFile: n.sourceFile,
          memberCount: n.memberCount, color: n.color,
          targetName: n.targetName,
          locations: prismNode?.locations,
          origin: prismNode?.origin,
          semanticContext: nodeContextMap.get(n.id) ?? null,
          contextPending: pendingContextIds.has(n.id),
        });
        hoverTimerRef.current = setTimeout(() => {
          if (n.location.file && onRequestFilePreview) {
            onRequestFilePreview(n.id, n.location.file);
          }
        }, 200);
      })
      .onBackgroundClick(() => {
        setSelectedNode(null);
        resetCamera();
      })
      .onNodeDrag((node: unknown) => {
        if (graphRef.current) { graphRef.current.resumeAnimation(); }
        const n = node as GraphNode;
        if (!n.isFileNode) return;
        const currentFileMap = new Map<string, string[]>();
        for (const gn of (graph.graphData().nodes as GraphNode[])) {
          if (gn.isGlobal && gn.fileNodeId) {
            const list = currentFileMap.get(gn.fileNodeId) ?? [];
            list.push(gn.id);
            currentFileMap.set(gn.fileNodeId, list);
          }
        }
        const children = currentFileMap.get(n.id) ?? [];
        const currentNodes = graph.graphData().nodes as GraphNode[];
        for (const child of children) {
          const childNode = currentNodes.find((c) => c.id === child);
          if (!childNode) continue;
          const angle = Math.random() * Math.PI * 2;
          const r = ORBIT_RADIUS * (0.5 + Math.random() * 0.5);
          childNode.fx = (n.x ?? 0) + Math.cos(angle) * r;
          childNode.fy = (n.y ?? 0) + Math.sin(angle) * r;
          childNode.fz = (n.z ?? 0) + (Math.random() - 0.5) * r * 0.5;
        }
      })
      .onNodeDragEnd((node: unknown) => {
        const n = node as GraphNode;
        if (!n.isFileNode) return;
        const currentNodes = graph.graphData().nodes as GraphNode[];
        const children = currentNodes.filter((c) => c.isGlobal && c.fileNodeId === n.id).map((c) => c.id);
        for (const child of children) {
          const childNode = currentNodes.find((c) => c.id === child);
          if (childNode) { childNode.fx = undefined; childNode.fy = undefined; childNode.fz = undefined; }
        }
      })
      .linkColor((link: unknown) => (link as GraphLink).color)
      .linkOpacity(0.2)
      .linkLabel((link: unknown) => {
        const l = link as GraphLink;
        const labels: Record<string, string> = {
          call: "Calls", access: "Access", conformance: "Conforms", inheritance: "Inherits",
          nesting: "Contains", observer_trigger: "Observes", resource_link: "Uses",
          cross_target_dependency: "Cross-module", macro_expansion: "Expands",
          extension_contribution: "Extends", resource_containment: "", file_containment: "",
          resource_alias: "Aliases", heuristic_link: "References",
        };
        return labels[l.linkType] || "";
      })
      .onLinkClick((link: unknown) => {
        const l = link as GraphLink;
        if (!l.references || l.references.length === 0) return;
        const src = typeof l.source === "object" ? l.source as GraphNode : null;
        if (src && graphRef.current) {
          const screen = graphRef.current.graph2ScreenCoords(src.x ?? 0, src.y ?? 0, src.z ?? 0);
          setLinkMenuPos({ x: screen.x, y: screen.y });
        } else {
          setLinkMenuPos({ x: 200, y: 200 });
        }
        setClickedLink(l);
      })
      .onLinkHover((link: unknown) => {
        if (!link) {
          document.body.style.cursor = "default";
          return;
        }
        const l = link as GraphLink;
        document.body.style.cursor = (l.references && l.references.length > 0) ? "pointer" : "default";
      })
      .linkDirectionalArrowLength(2)
      .linkDirectionalArrowRelPos(0.85)
      .linkDirectionalArrowColor((link: unknown) => (link as GraphLink).color)
      .linkCurvature(nodeCount > 500 ? 0 : (link: unknown) => {
        const l = link as GraphLink;
        if (l.linkType === "nesting" || l.linkType === "file_containment" || l.linkType === "resource_containment") return 0;
        return 0.1;
      })
      .d3AlphaDecay(sim.alphaDecay)
      .d3VelocityDecay(sim.velocityDecay)
      .warmupTicks(sim.warmupTicks)
      .cooldownTicks(sim.cooldownTicks);

    graph.d3Force("charge")?.strength((node: unknown) => {
      const n = node as GraphNode;
      if (n.hidden) return 0;
      if (n.flavor === "target") return sim.chargeStrength * 3;  // strong repulsion between hubs
      if (n.isGlobal) return sim.chargeStrength * 0.15;
      if (n.isFileNode) return sim.chargeStrength * 0.5;
      if (n.flavor === "resource" && n.parentId) return sim.chargeStrength * 0.2;
      return sim.chargeStrength;
    });

    graph.d3Force("link")?.distance((link: unknown) => {
      const l = link as GraphLink;
      if (l.linkType === "import_dependency") return sim.linkDistance * 2.5;  // target-to-target: wide orbit
      if (l.linkType === "file_containment") return ORBIT_RADIUS;
      if (l.linkType === "nesting") return ORBIT_RADIUS * 0.8;
      if (l.linkType === "resource_containment") return ORBIT_RADIUS * 0.7;
      if (l.linkType === "inheritance" || l.linkType === "conformance") return sim.linkDistance * 0.6;
      if (l.linkType === "cross_target_dependency") return sim.linkDistance * 1.5;
      return sim.linkDistance;
    });

    graph.d3Force("center")?.strength(sim.centerStrength);

    import("d3-force-3d").then((d3: any) => {
      if (!graphRef.current) return;

      graph.d3Force("collide", d3.forceCollide((node: unknown) => {
        const n = node as GraphNode;
        if (n.hidden) return 0;
        return n.size * 1.2;
      }));

      graph.d3Force("radial", d3.forceRadial((node: unknown) => {
        const n = node as GraphNode;
        if (n.flavor === "target") return 0;     // hubs at center
        if (n.isModule) return 20;
        if (TOP_LEVEL_FLAVORS.has(n.flavor as string)) return 80;
        if (n.flavor === "resource") return 200;
        if (n.isGlobal) return 160;
        return 120;
      }, 0, 0, 0).strength((node: unknown) => {
        const n = node as GraphNode;
        if (n.hidden) return 0;
        if (n.flavor === "target") return 0.12;   // strong pull to center
        if (n.isModule) return 0.08;
        if (TOP_LEVEL_FLAVORS.has(n.flavor as string)) return 0.03;
        if (n.flavor === "resource") return 0.05;
        return 0.01;
      }));

      const targetGroups = new Map<string, { cx: number; cy: number; cz: number; count: number }>();
      graph.d3Force("cluster", (alpha: number) => {
        targetGroups.clear();
        const currentNodes = graph.graphData().nodes as GraphNode[];
        for (const n of currentNodes) {
          if (n.hidden || !n.targetName) continue;
          const g = targetGroups.get(n.targetName) ?? { cx: 0, cy: 0, cz: 0, count: 0 };
          g.cx += n.x ?? 0;
          g.cy += n.y ?? 0;
          g.cz += n.z ?? 0;
          g.count++;
          targetGroups.set(n.targetName, g);
        }
        for (const g of targetGroups.values()) {
          if (g.count > 0) { g.cx /= g.count; g.cy /= g.count; g.cz /= g.count; }
        }
        const strength = alpha * 0.03;
        for (const n of currentNodes) {
          if (n.hidden || !n.targetName) continue;
          const g = targetGroups.get(n.targetName);
          if (!g || g.count < 2) continue;
          const nx = n as GraphNode & { vx?: number; vy?: number; vz?: number };
          nx.vx = (nx.vx ?? 0) + (g.cx - (n.x ?? 0)) * strength;
          nx.vy = (nx.vy ?? 0) + (g.cy - (n.y ?? 0)) * strength;
          nx.vz = (nx.vz ?? 0) + (g.cz - (n.z ?? 0)) * strength;
        }
      });
    }).catch(() => {
      /* d3-force-3d not available — skip custom forces */
    });

    graphRef.current = graph;

    const stabilizeTimer = setTimeout(() => {
      if (graphRef.current) {
        graphRef.current.pauseAnimation();
        console.log("[SwiftPrism] Physics paused after stabilization");
      }
    }, nodeCount > 300 ? 12000 : 8000);

    let lodFrameCount = 0;
    const lodSkip = nodeCount > 500 ? 3 : 1;

    const runLodPass = () => {
      if (!graphRef.current) return;
      lodFrameCount++;
      if (lodFrameCount % lodSkip !== 0) {
        animFrameRef.current = requestAnimationFrame(runLodPass);
        return;
      }
      const camera = graphRef.current.camera();
      const camPos = camera.position;
      const currentNodes = graphRef.current.graphData().nodes as GraphNode[];

      for (const node of currentNodes) {
        const group = node.__threeObj as THREE.Group | undefined;
        if (!group?.userData?.sprite) continue;
        const spr = group.userData.sprite as THREE.Sprite;

        const nx = node.x ?? 0;
        const ny = node.y ?? 0;
        const nz = node.z ?? 0;
        const dx = camPos.x - nx;
        const dy = camPos.y - ny;
        const dz = camPos.z - nz;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

        // Target hubs and entry points always stay full — skip global LOD
        if (node.isTargetHub || node.flavor === "entry_point") continue;

        if (node.isGlobal) {
          const wantLod = dist < LOD_NEAR * 0.6 ? "full" : "dot";
          if (wantLod !== group.userData.currentLod) {
            spr.material = createSpriteTexture(node, wantLod);
            const scale = wantLod === "dot" ? node.size * 1.2 : node.size * 2.5;
            spr.scale.set(scale, scale, 1);
            group.userData.currentLod = wantLod;
            group.userData.baseScale = scale;
          }
          continue;
        }

        const wantLod = dist < LOD_NEAR ? "full" : dist > LOD_FAR ? "dot" : group.userData.currentLod;
        if (wantLod !== group.userData.currentLod) {
          spr.material = createSpriteTexture(node, wantLod);
          const scale = wantLod === "dot" ? node.size * 0.8 : node.size * 1.8;
          spr.scale.set(scale, scale, 1);
          group.userData.currentLod = wantLod;
          group.userData.baseScale = scale;
        }
      }

      const LINK_CULL_DIST = LOD_FAR * 1.5;
      const currentLinks = graphRef.current.graphData().links as (GraphLink & { __lineObj?: THREE.Object3D; source: any; target: any })[];
      for (const link of currentLinks) {
        if (!link.__lineObj) continue;
        if (link.hidden) { link.__lineObj.visible = false; continue; }
        const sx = typeof link.source === "object" ? link.source.x ?? 0 : 0;
        const sy = typeof link.source === "object" ? link.source.y ?? 0 : 0;
        const sz = typeof link.source === "object" ? link.source.z ?? 0 : 0;
        const mx = sx;
        const my = sy;
        const mz = sz;
        const ld = Math.sqrt((camPos.x - mx) ** 2 + (camPos.y - my) ** 2 + (camPos.z - mz) ** 2);
        const isStructural = link.linkType === "nesting" || link.linkType === "inheritance" || link.linkType === "conformance" || link.linkType === "cross_target_dependency";
        link.__lineObj.visible = ld < LINK_CULL_DIST || isStructural;
      }

      animFrameRef.current = requestAnimationFrame(runLodPass);
    };

    animFrameRef.current = requestAnimationFrame(runLodPass);
    return graph;
  }, [handleNodeClick, onClearPreview, onRequestFilePreview, resetCamera]);

  // Reset graph instance when result identity changes (null→data or data→new data)
  const resultGeneration = useRef(0);
  useEffect(() => {
    resultGeneration.current++;
    initialLoadDone.current = false;

    // Tear down existing graph on data change
    if (graphRef.current && containerRef.current) {
      graphRef.current.pauseAnimation();
      graphRef.current._destructor?.();
      graphRef.current = null;
      // Clear the DOM — force-graph appends canvas elements
      while (containerRef.current.firstChild) {
        containerRef.current.removeChild(containerRef.current.firstChild);
      }
    }
  }, [result]);

  useEffect(() => {
    if (!graphRef.current) {
      const graph = initGraph();
      if (!graph) return;
      graph.graphData(graphData);
    }
    const handleResize = () => {
      if (!containerRef.current || !graphRef.current) return;
      graphRef.current.width(containerRef.current.clientWidth).height(containerRef.current.clientHeight);
    };
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { observer.disconnect(); cancelAnimationFrame(animFrameRef.current); };
  }, [initGraph, graphData]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!graphRef.current) return;

    const visibleNodes = graphData.nodes.filter((n) => !n.hidden);
    const visibleLinks = graphData.links.filter((l) => !l.hidden);
    console.log(`[SwiftPrism] Graph update: ${graphData.nodes.length} total nodes (${visibleNodes.length} visible), ${graphData.links.length} total links (${visibleLinks.length} visible)`);

    if (graphData.nodes.length === 0) {
      console.warn("[SwiftPrism] No nodes to render — check if analysis produced results");
      return;
    }

    const nodesWithoutId = graphData.nodes.filter((n) => !n.id);
    if (nodesWithoutId.length > 0) {
      console.error(`[SwiftPrism] ${nodesWithoutId.length} nodes have no id — these will not render`);
    }

    graphRef.current.graphData(graphData);

    if (initialLoadDone.current) {
      graphRef.current.cooldownTicks(0);
    } else {
      initialLoadDone.current = true;
      setTimeout(() => {
        graphRef.current?.zoomToFit(400, 60);
      }, 500);
    }
  }, [graphData]);

  // ── "Thinking..." ring on nodes awaiting semantic context ──
  // Adds a pulsing cyan ring overlay on each pending node's THREE.Group.
  // When the node's context arrives, the ring is removed automatically.
  const thinkingRingsRef = useRef<Map<string, THREE.Sprite>>(new Map());
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;
    const data = graph.graphData();
    const nodes = data.nodes as GraphNode[];
    const rings = thinkingRingsRef.current;

    // Remove rings for nodes no longer pending
    for (const [id, ring] of rings) {
      if (!pendingContextIds.has(id)) {
        ring.parent?.remove(ring);
        ring.material.dispose();
        if (ring.material.map) ring.material.map.dispose();
        rings.delete(id);
      }
    }

    // Add rings for newly pending nodes
    for (const node of nodes) {
      if (!pendingContextIds.has(node.id)) continue;
      if (rings.has(node.id)) continue;
      const group = node.__threeObj as THREE.Group | undefined;
      if (!group) continue;

      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      // Pulsing cyan ring
      ctx.beginPath();
      ctx.arc(32, 32, 24, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0, 230, 255, 0.6)";
      ctx.lineWidth = 3;
      ctx.stroke();
      // Small inner dots to suggest "thinking"
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 2) {
        ctx.beginPath();
        ctx.arc(32 + Math.cos(angle) * 18, 32 + Math.sin(angle) * 18, 2, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(0, 230, 255, 0.8)";
        ctx.fill();
      }
      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, sizeAttenuation: true });
      const ring = new THREE.Sprite(mat);
      const baseScale = group.userData?.baseScale ?? 6;
      ring.scale.set(baseScale * 2.2, baseScale * 2.2, 1);
      ring.userData.__thinkingRing = true;
      group.add(ring);
      rings.set(node.id, ring);
    }
  }, [pendingContextIds]);

  useEffect(() => {
    const MOVE_SPEED = 3;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "/" || e.key === "f" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setSearchQuery("");
        return;
      }
      keysPressed.current.add(e.key.toLowerCase());
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      keysPressed.current.delete(e.key.toLowerCase());
    };

    const moveLoop = () => {
      if (!graphRef.current || keysPressed.current.size === 0) {
        keyAnimRef.current = requestAnimationFrame(moveLoop);
        return;
      }
      const camera = graphRef.current.camera();
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();

      if (keysPressed.current.has("w")) camera.position.addScaledVector(dir, MOVE_SPEED);
      if (keysPressed.current.has("s")) camera.position.addScaledVector(dir, -MOVE_SPEED);
      if (keysPressed.current.has("a")) camera.position.addScaledVector(right, -MOVE_SPEED);
      if (keysPressed.current.has("d")) camera.position.addScaledVector(right, MOVE_SPEED);
      if (keysPressed.current.has("q") || keysPressed.current.has(" ")) camera.position.y += MOVE_SPEED;
      if (keysPressed.current.has("e") || keysPressed.current.has("shift")) camera.position.y -= MOVE_SPEED;

      keyAnimRef.current = requestAnimationFrame(moveLoop);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    keyAnimRef.current = requestAnimationFrame(moveLoop);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      cancelAnimationFrame(keyAnimRef.current);
    };
  }, []);

  const handleSearch = useCallback((query: string) => {
    if (!graphRef.current || !query.trim()) return;
    const q = query.toLowerCase();
    const nodes = graphRef.current.graphData().nodes as GraphNode[];
    const match = nodes.find((n) => !n.hidden && (n.name.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)));
    if (match) {
      flyToNode(match);
      setSelectedNode(match);
      setSearchOpen(false);
      setSearchQuery("");
    }
  }, [flyToNode]);

  if (schemaError) {
    return (
      <div style={{ ...styles.empty, color: "#EF5350", flexDirection: "column", gap: 8 }}>
        <div style={{ fontSize: "1.2em", fontWeight: 700 }}>System Reset Required</div>
        <div style={{ fontSize: "0.85em", opacity: 0.7 }}>{schemaError}</div>
      </div>
    );
  }

  if (!result) return <div style={styles.empty}>Run analysis to see the dependency graph.</div>;

  return (
    <div style={styles.wrapper}>
      <div ref={containerRef} style={styles.container} />
      {searchOpen && (
        <div style={searchStyles.bar}>
          <input
            autoFocus
            style={searchStyles.input}
            placeholder="Search node..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSearch(searchQuery);
              if (e.key === "Escape") { setSearchOpen(false); setSearchQuery(""); }
            }}
          />
          <button
            style={searchStyles.button}
            onClick={() => handleSearch(searchQuery)}
          >
            Go
          </button>
          <button
            style={searchStyles.close}
            onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
          >
            {"\u2715"}
          </button>
        </div>
      )}
      {!searchOpen && (
        <button
          style={searchStyles.trigger}
          onClick={() => setSearchOpen(true)}
          title="Search nodes (press /)"
        >
          {"\u{1F50D}"}
        </button>
      )}

      <NodeDetailCard
        node={hoveredNodeInfo}
        preview={hoveredNodeId && filePreview && filePreview.nodeId === hoveredNodeId ? filePreview : null}
        position={hoverPos}
        containerWidth={containerRef.current?.clientWidth ?? 600}
        containerHeight={containerRef.current?.clientHeight ?? 400}
        result={result}
        pinned={cardPinned}
        onMouseEnterCard={() => {
          cardHoveredRef.current = true;
          if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
        }}
        onMouseLeaveCard={() => {
          cardHoveredRef.current = false;
          hideTimerRef.current = setTimeout(() => {
            if (!cardHoveredRef.current) {
              setHoveredNodeId(null);
              setHoveredNodeInfo(null);
              setHoverPos(null);
              setCardPinned(false);
              onClearPreview?.();
            }
          }, 100);
        }}
        onOpenFile={onOpenFile}
      />

      <FilterPanel linkTypes={presentLinkTypes} visibleLinkTypes={visibleLinkTypes} onToggle={handleToggleLink}
        collapsed={collapsed} onToggleCollapse={handleToggleCollapse} totalNodes={allNodes.length} visibleNodes={visibleNodeIds.size}
        showStructural={showStructural} onToggleStructural={() => setShowStructural((p) => !p)} />

      {clickedLink && linkMenuPos && clickedLink.references && clickedLink.references.length > 0 && (
        <div style={{ ...callSiteStyles.menu, left: linkMenuPos.x + 12, top: linkMenuPos.y - 20 }}>
          <div style={callSiteStyles.header}>
            <span style={callSiteStyles.title}>Call Sites ({clickedLink.references.length})</span>
            <button style={callSiteStyles.close} onClick={() => setClickedLink(null)}>{"\u2715"}</button>
          </div>
          {clickedLink.references.map((ref, i) => (
            <div
              key={`${ref.file}:${ref.line}:${i}`}
              style={callSiteStyles.item}
              onClick={() => {
                onOpenFile?.({ file: ref.file, line: ref.line, col: ref.column });
                setClickedLink(null);
              }}
            >
              <div style={callSiteStyles.snippet}>{ref.snippet}</div>
              <div style={callSiteStyles.location}>{ref.file.split("/").pop()}:{ref.line}</div>
            </div>
          ))}
        </div>
      )}

      {selectedNode && (
        <div style={styles.contextPanel}>
          <div style={styles.contextHeader}>
            <span style={styles.contextTitle}>{selectedNode.name}</span>
            <span style={styles.contextFlavor}>[{selectedNode.flavor}]</span>
            <button style={styles.contextClose} onClick={() => setSelectedNode(null)}>{"\u2715"}</button>
          </div>
          <div style={styles.contextId}>{selectedNode.id}{selectedNode.isGlobal && " (global)"}</div>
          <div style={styles.contextLocation}>
            {selectedNode.parentFile ? `${selectedNode.parentFile} \u2014 ` : ""}
            {selectedNode.location.file}:{selectedNode.location.line}
          </div>
          {selectedNode.isTopLevel && !selectedNode.isFileNode && !selectedNode.isModule && result && (() => {
            const members = result.nodes.filter((n) => n.parent === selectedNode.id);
            if (members.length === 0) return null;
            const grouped = new Map<string, typeof members>();
            for (const m of members) {
              const file = m.sourceFile || "unknown";
              const list = grouped.get(file) ?? [];
              list.push(m);
              grouped.set(file, list);
            }
            if (grouped.size <= 1) return null;
            return (
              <div style={styles.extensionGroup}>
                {Array.from(grouped.entries()).map(([file, items]) => (
                  <div key={file} style={styles.extensionFile}>
                    <span style={styles.extensionFileName}>Methods from {file}</span>
                    <span style={styles.extensionCount}>{items.length}</span>
                  </div>
                ))}
              </div>
            );
          })()}
          <div style={styles.buttonRow}>
            {onOpenFile && selectedNode.location.file && (
              <button style={styles.openButton} onClick={() => onOpenFile({ file: selectedNode.location.file, line: selectedNode.location.line, col: selectedNode.location.column })}>
                Open File
              </button>
            )}
            {onCopyContext && !selectedNode.isFileNode && (
              <button style={styles.copyButton} onClick={() => { onCopyContext(selectedNode.id); setSelectedNode(null); }}>
                Copy Context for AI
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { width: "100%", height: "100%", position: "relative" },
  container: { width: "100%", height: "100%", overflow: "hidden" },
  empty: { display: "flex", alignItems: "center", justifyContent: "center", height: "100%", opacity: 0.5 },
  contextPanel: { position: "absolute", bottom: 12, left: 12, right: 12, background: "var(--vscode-editor-background)", border: "1px solid var(--vscode-panel-border)", borderRadius: 6, padding: 12, zIndex: 10 },
  contextHeader: { display: "flex", alignItems: "center", gap: 8, marginBottom: 4 },
  contextTitle: { fontWeight: 600, fontSize: "0.95em" },
  contextFlavor: { opacity: 0.5, fontSize: "0.8em" },
  contextClose: { marginLeft: "auto", background: "transparent", border: "none", color: "var(--vscode-foreground)", cursor: "pointer", fontSize: "1em", opacity: 0.5 },
  contextId: { fontSize: "0.75em", opacity: 0.4, fontFamily: "var(--vscode-editor-font-family)" },
  contextLocation: { fontSize: "0.75em", opacity: 0.5, fontFamily: "var(--vscode-editor-font-family)", marginBottom: 8 },
  buttonRow: { display: "flex", gap: 8 },
  openButton: { flex: 1, background: "var(--vscode-button-secondaryBackground, #3A3D41)", color: "var(--vscode-button-secondaryForeground, #ccc)", border: "none", borderRadius: 4, padding: "8px 16px", cursor: "pointer", fontFamily: "var(--vscode-font-family)", fontSize: "var(--vscode-font-size)", fontWeight: 600 },
  copyButton: { flex: 1, background: "var(--vscode-button-background)", color: "var(--vscode-button-foreground)", border: "none", borderRadius: 4, padding: "8px 16px", cursor: "pointer", fontFamily: "var(--vscode-font-family)", fontSize: "var(--vscode-font-size)", fontWeight: 600 },
  extensionGroup: { marginBottom: 8, borderTop: "1px solid var(--vscode-panel-border)", paddingTop: 6 },
  extensionFile: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0", fontSize: "0.75em" },
  extensionFileName: { color: "#42A5F5", opacity: 0.8 },
  extensionCount: { opacity: 0.4, fontSize: "0.9em" },
};

const filterStyles: Record<string, React.CSSProperties> = {
  wrapper: { position: "absolute", top: 8, right: 8, zIndex: 20 },
  toggle: { width: 32, height: 32, borderRadius: 6, border: "1px solid var(--vscode-panel-border)", background: "var(--vscode-editor-background)", color: "var(--vscode-foreground)", cursor: "pointer", fontSize: "1em", display: "flex", alignItems: "center", justifyContent: "center", marginLeft: "auto" },
  panel: { marginTop: 4, background: "var(--vscode-editor-background)", border: "1px solid var(--vscode-panel-border)", borderRadius: 6, padding: 10, minWidth: 180, maxHeight: 320, overflowY: "auto" as const },
  section: { display: "flex", flexDirection: "column" as const, gap: 4, marginBottom: 10 },
  label: { fontSize: "0.7em", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em", opacity: 0.5, marginBottom: 2 },
  row: { display: "flex", alignItems: "center", gap: 6, fontSize: "0.8em", cursor: "pointer" },
  checkbox: { accentColor: "var(--vscode-button-background)", cursor: "pointer" },
  count: { fontSize: "0.7em", opacity: 0.4, marginTop: 2 },
};

const searchStyles: Record<string, React.CSSProperties> = {
  trigger: {
    position: "absolute",
    top: 8,
    left: 8,
    zIndex: 20,
    width: 32,
    height: 32,
    borderRadius: 6,
    border: "1px solid var(--vscode-panel-border)",
    background: "var(--vscode-editor-background)",
    color: "var(--vscode-foreground)",
    cursor: "pointer",
    fontSize: "0.85em",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  bar: {
    position: "absolute",
    top: 8,
    left: 8,
    zIndex: 25,
    display: "flex",
    gap: 4,
    alignItems: "center",
    background: "var(--vscode-editor-background)",
    border: "1px solid var(--vscode-panel-border)",
    borderRadius: 6,
    padding: 4,
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
  },
  input: {
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--vscode-foreground)",
    fontFamily: "var(--vscode-font-family)",
    fontSize: "0.85em",
    width: 180,
    padding: "4px 8px",
  },
  button: {
    background: "var(--vscode-button-background)",
    color: "var(--vscode-button-foreground)",
    border: "none",
    borderRadius: 4,
    padding: "4px 10px",
    cursor: "pointer",
    fontSize: "0.8em",
    fontWeight: 600,
  },
  close: {
    background: "transparent",
    border: "none",
    color: "var(--vscode-foreground)",
    cursor: "pointer",
    fontSize: "0.9em",
    opacity: 0.5,
    padding: "4px 6px",
  },
};

const callSiteStyles: Record<string, React.CSSProperties> = {
  menu: {
    position: "absolute",
    zIndex: 35,
    background: "rgba(30, 30, 30, 0.92)",
    backdropFilter: "blur(12px)",
    border: "1px solid rgba(255,255,255,0.1)",
    borderRadius: 8,
    padding: 0,
    maxWidth: 320,
    maxHeight: 240,
    overflow: "auto",
    boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px 6px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  title: {
    fontSize: "0.75em",
    fontWeight: 600,
    opacity: 0.7,
  },
  close: {
    background: "transparent",
    border: "none",
    color: "var(--vscode-foreground)",
    cursor: "pointer",
    fontSize: "0.8em",
    opacity: 0.4,
  },
  item: {
    padding: "6px 10px",
    cursor: "pointer",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
    transition: "background 0.1s",
  },
  snippet: {
    fontSize: "0.7em",
    fontFamily: "var(--vscode-editor-font-family, monospace)",
    color: "rgba(255,255,255,0.8)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  location: {
    fontSize: "0.6em",
    color: "rgba(255,255,255,0.35)",
    marginTop: 2,
  },
};

