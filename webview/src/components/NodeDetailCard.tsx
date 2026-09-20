import { AnimatePresence, motion } from "framer-motion";
import type {
  FilePreview,
  AnalysisResult,
  PrismNode,
  PrismLink,
  SymbolFlavor,
} from "../protocol";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HoveredNodeInfo {
  id: string;
  name: string;
  flavor: string;
  subKind: string | null;
  isStatic: boolean;
  isGlobal: boolean;
  isModule: boolean;
  parentId: string | null;
  sourceFile: string;
  memberCount: number | null;
  color: string;
  targetName?: string | null;
  /** Object-only: extension block locations for "Defined In" */
  locations?: { file: string; line: number; column: number }[];
  /** Target-only: origin path/URL */
  origin?: string;
  /** Token-optimized semantic context from local LLM or fallback */
  semanticContext?: string | null;
  /** Whether this node is still awaiting context generation */
  contextPending?: boolean;
}

interface NodeDetailCardProps {
  node: HoveredNodeInfo | null;
  preview: FilePreview | null;
  position: { x: number; y: number } | null;
  containerWidth: number;
  containerHeight: number;
  result: AnalysisResult | null;
  pinned: boolean;
  onMouseEnterCard: () => void;
  onMouseLeaveCard: () => void;
  onOpenFile?: (location: { file: string; line: number; col: number }) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const FLAVOR_ICONS: Record<string, string> = {
  struct: "\u25A0",
  class: "\u25CF",
  enum: "\u25C6",
  actor: "\u25B2",
  protocol: "\u25CE",
  function: "\u0192",
  variable: "x",
  initializer: "\u2295",
  macro: "\u26A1",
  resource: "\u{1F4C1}",
  module: "\u{1F4E6}",
  file: "\u{1F4C4}",
  entry_point: "\u2606",
  target: "\u{1F3AF}",
};

const FLAVOR_LABELS: Record<string, string> = {
  struct: "Struct",
  class: "Class",
  enum: "Enum",
  actor: "Actor",
  protocol: "Protocol",
  function: "Function",
  variable: "Variable",
  initializer: "Initializer",
  macro: "Macro",
  resource: "Resource",
  module: "Module",
  file: "File",
  entry_point: "Entry Point",
  target: "Target",
  image_set: "Image Asset",
  color_set: "Color Asset",
  data_set: "Data Asset",
  asset_catalog: "Asset Catalog",
  json_file: "JSON",
  plist_file: "Property List",
  markdown_file: "Markdown",
  strings_file: "Strings",
  localization: "Localization",
};

const FLAVOR_COLORS: Record<string, string> = {
  struct: "#4FC3F7",
  class: "#7E57C2",
  enum: "#FF8A65",
  actor: "#26A69A",
  protocol: "#FFD54F",
  function: "#42A5F5",
  variable: "#66BB6A",
  initializer: "#AB47BC",
  macro: "#FF7043",
  entry_point: "#FFD700",
  target: "#42A5F5",
  target_apple: "#42A5F5",
  target_remote: "#FF9800",
  target_local: "#66BB6A",
  target_internal: "#80DEEA",
  resource: "#29B6F6",
  module: "#5C6BC0",
  file: "#546E7A",
  didSet: "#E040FB",
  willSet: "#F48FB1",
  computed: "#81D4FA",
  getter: "#A5D6A7",
  setter: "#EF9A9A",
};

const OBJECT_FLAVORS = new Set(["struct", "class", "enum", "actor", "protocol"]);
const EXEC_FLAVORS = new Set(["function", "initializer"]);

// ═══════════════════════════════════════════════════════════════════════════════
// METADATA RESOLVERS
// ═══════════════════════════════════════════════════════════════════════════════

function resolveColorForFlavor(flavor: string, subKind: string | null): string {
  if (subKind && FLAVOR_COLORS[subKind]) return FLAVOR_COLORS[subKind];
  return FLAVOR_COLORS[flavor] ?? "#BDBDBD";
}

interface InspectorData {
  ownership: string | null;
  extends_: string | null;
  implements_: string[];
  inits: string[];
  deinits: string[];
  staticMethods: string[];
  instanceMethods: string[];
  observers: { kind: string; property: string }[];
  stores: string[];
  directCalls: string[];
  referencedBy: string[];
  containsSymbols: string[];
  accessorFor: string | null;
}

function buildInspectorData(
  nodeInfo: HoveredNodeInfo,
  result: AnalysisResult | null
): InspectorData {
  const data: InspectorData = {
    ownership: null,
    extends_: null,
    implements_: [],
    inits: [],
    deinits: [],
    staticMethods: [],
    instanceMethods: [],
    observers: [],
    stores: [],
    directCalls: [],
    referencedBy: [],
    containsSymbols: [],
    accessorFor: null,
  };

  if (!result) return data;

  const nodeById = new Map<string, PrismNode>();
  for (const n of result.nodes) nodeById.set(n.id, n);

  const prismNode = nodeById.get(nodeInfo.id);

  // Ownership: "Part of [Object]" or "Top-level in [File]"
  if (nodeInfo.parentId) {
    const parent = nodeById.get(nodeInfo.parentId);
    data.ownership = parent ? parent.name : nodeInfo.parentId;
  }

  // Property accessor detection: willSet/didSet/get/set → "Accessor for property: X"
  if (nodeInfo.subKind && ["willSet", "didSet", "getter", "setter", "computed"].includes(nodeInfo.subKind)) {
    if (prismNode?.parent) {
      const parentProp = nodeById.get(prismNode.parent);
      if (parentProp && parentProp.flavor === "variable") {
        data.accessorFor = parentProp.name;
      }
    }
  }

  // For objects: extends, implements, members breakdown
  if (OBJECT_FLAVORS.has(nodeInfo.flavor)) {
    for (const link of result.links) {
      if (link.source_id !== nodeInfo.id) continue;
      const target = nodeById.get(link.target_id);
      const targetName = target?.name ?? link.target_id;
      if (link.type === "inheritance") {
        if (nodeInfo.flavor === "class" && !data.extends_) {
          data.extends_ = targetName;
        } else {
          data.implements_.push(targetName);
        }
      }
      if (link.type === "conformance") data.implements_.push(targetName);
      if (link.type === "holds_type") data.stores.push(targetName);
    }

    // Members
    for (const n of result.nodes) {
      if (n.parent !== nodeInfo.id) continue;
      if (n.flavor === "initializer") {
        data.inits.push(n.name);
      } else if (n.name === "deinit" && n.flavor === "function") {
        data.deinits.push(n.name);
      } else if (n.flavor === "function") {
        if (n.isStatic) data.staticMethods.push(n.name);
        else data.instanceMethods.push(n.name);
      } else if (n.flavor === "variable" && n.subKind && n.subKind !== "stored") {
        data.observers.push({ kind: n.subKind, property: n.name });
      }
    }
  }

  // For functions / execution bodies: direct calls
  if (EXEC_FLAVORS.has(nodeInfo.flavor) || nodeInfo.flavor === "variable") {
    for (const link of result.links) {
      if (link.source_id !== nodeInfo.id) continue;
      if (link.type === "call" || link.type === "access" || link.type === "observer_trigger") {
        const target = nodeById.get(link.target_id);
        if (target) data.directCalls.push(target.name);
      }
    }
  }

  // For files: list all top-level symbols in the same source file
  if (nodeInfo.flavor === "file") {
    for (const n of result.nodes) {
      if (n.parentFile === nodeInfo.name && !n.parent && OBJECT_FLAVORS.has(n.flavor)) {
        data.containsSymbols.push(`${FLAVOR_LABELS[n.flavor] ?? n.flavor} ${n.name}`);
      }
    }
    // Also global functions
    for (const n of result.nodes) {
      if (n.parentFile === nodeInfo.name && n.isGlobal && !n.parent && n.flavor === "function") {
        data.containsSymbols.push(`Function ${n.name}`);
      }
    }
  }

  // For resources / non-code: "Referenced By" (who uses this resource)
  if (nodeInfo.flavor === "resource" || ["image_set", "color_set", "data_set", "asset_catalog", "json_file", "plist_file", "markdown_file", "strings_file", "localization"].includes(nodeInfo.flavor)) {
    for (const link of result.links) {
      if (link.target_id !== nodeInfo.id) continue;
      if (link.type === "resource_link" || link.type === "resource_alias" || link.type === "heuristic_link") {
        const source = nodeById.get(link.source_id);
        if (source) data.referencedBy.push(source.name);
      }
    }
  }

  // General: who references this node (incoming calls/access) — for all types
  if (!nodeInfo.flavor.includes("resource") && nodeInfo.flavor !== "file") {
    for (const link of result.links) {
      if (link.target_id !== nodeInfo.id) continue;
      if (link.type === "call" || link.type === "access") {
        const source = nodeById.get(link.source_id);
        if (source) data.referencedBy.push(source.name);
      }
    }
  }

  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION RENDERERS
// ═══════════════════════════════════════════════════════════════════════════════

function TagList({ items, color, label }: { items: string[]; color: string; label: string }) {
  if (items.length === 0) return null;
  return (
    <div style={sectionStyles.row}>
      <span style={sectionStyles.label}>{label}</span>
      <div style={sectionStyles.tagWrap}>
        {items.map((item, i) => (
          <span key={`${item}-${i}`} style={{ ...sectionStyles.tag, borderColor: color, color }}>
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

function InfoRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={sectionStyles.infoRow}>
      <span style={sectionStyles.infoLabel}>{label}</span>
      <span style={{ ...sectionStyles.infoValue, color: color ?? "rgba(255,255,255,0.75)" }}>{value}</span>
    </div>
  );
}

function ObserverList({ observers }: { observers: { kind: string; property: string }[] }) {
  if (observers.length === 0) return null;
  return (
    <div style={sectionStyles.row}>
      <span style={sectionStyles.label}>Logic Bodies</span>
      <div style={sectionStyles.tagWrap}>
        {observers.map((obs, i) => (
          <span
            key={`${obs.property}-${obs.kind}-${i}`}
            style={{ ...sectionStyles.tag, borderColor: resolveColorForFlavor("variable", obs.kind), color: resolveColorForFlavor("variable", obs.kind) }}
          >
            {obs.property}.{obs.kind}
          </span>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function NodeDetailCard({
  node,
  preview,
  position,
  containerWidth,
  containerHeight,
  result,
  pinned,
  onMouseEnterCard,
  onMouseLeaveCard,
  onOpenFile,
}: NodeDetailCardProps) {
  if (!position) return null;

  const cardWidth = 280;
  const cardMaxHeight = 400;
  const OFFSET = 20;
  const EDGE_PADDING = 10;

  let left = position.x - cardWidth / 2;
  if (left < EDGE_PADDING) left = EDGE_PADDING;
  if (left + cardWidth > containerWidth - EDGE_PADDING) left = containerWidth - cardWidth - EDGE_PADDING;

  let top = position.y - cardMaxHeight - OFFSET;
  let flipped = false;
  if (top < 0) {
    top = position.y + OFFSET;
    flipped = true;
  }
  if (top + cardMaxHeight > containerHeight - EDGE_PADDING) {
    top = containerHeight - cardMaxHeight - EDGE_PADDING;
  }

  const pointerLeft = Math.max(16, Math.min(position.x - left, cardWidth - 16));

  const inspector = node ? buildInspectorData(node, result) : null;
  const isObject = node ? OBJECT_FLAVORS.has(node.flavor) : false;
  const isTarget = node?.flavor === "target";
  const isExec = node ? (EXEC_FLAVORS.has(node.flavor) || (node.flavor === "variable" && node.subKind && node.subKind !== "stored")) : false;
  const isFile = node?.flavor === "file";
  const isResource = node ? (node.flavor === "resource" || ["image_set", "color_set", "data_set", "json_file", "plist_file", "markdown_file"].includes(node.flavor)) : false;

  return (
    <AnimatePresence mode="wait">
      {node && (
        <motion.div
          key={node.id}
          initial={{ opacity: 0, scale: 0.92, y: flipped ? -6 : 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: flipped ? -4 : 4 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          style={{
            ...cardStyles.card,
            left,
            top,
            pointerEvents: pinned ? "auto" : "none",
          }}
          onMouseEnter={onMouseEnterCard}
          onMouseLeave={onMouseLeaveCard}
        >
          {/* Pointer triangle */}
          <div
            style={{
              ...cardStyles.pointer,
              left: pointerLeft - 6,
              ...(flipped
                ? { top: -6, borderBottom: "6px solid rgba(30, 30, 30, 0.92)", borderTop: "none" }
                : { bottom: -6, borderTop: "6px solid rgba(30, 30, 30, 0.92)", borderBottom: "none" }),
            }}
          />

          {/* Inner content wrapper with clip */}
          <div style={cardStyles.inner}>
            {/* ─── Header ─── */}
            <div style={cardStyles.header}>
              <span style={{ ...cardStyles.icon, color: node.color }}>
                {FLAVOR_ICONS[node.flavor] ?? "\u25CF"}
              </span>
              <div style={cardStyles.headerText}>
                <div style={cardStyles.name}>{node.name}</div>
                <div style={cardStyles.type}>
                  {FLAVOR_LABELS[node.flavor] ?? node.flavor}
                  {node.subKind && ` (${node.subKind})`}
                  {node.isStatic && " \u2022 static"}
                  {node.isGlobal && " \u2022 global"}
                  {isExec && inspector && inspector.directCalls.length === 0 && inspector.ownership && result?.nodes.some((n) => n.id === node.parentId && n.flavor === "protocol") && (
                    <span style={{ color: "#FFD54F", marginLeft: 4 }}>{" \u2022 Protocol Requirement"}</span>
                  )}
                  {isExec && inspector && inspector.directCalls.length > 0 && inspector.ownership && result?.nodes.some((n) => n.id === node.parentId && n.flavor === "protocol") && (
                    <span style={{ color: "#66BB6A", marginLeft: 4 }}>{" \u2022 Default Implementation"}</span>
                  )}
                </div>
              </div>
            </div>

            {/* ─── Semantic Context (AI Summary) ─── */}
            {node.contextPending && (
              <div style={{ padding: "4px 12px", fontSize: "0.78em", opacity: 0.5, fontStyle: "italic" }}>
                Thinking...
              </div>
            )}
            {!node.contextPending && node.semanticContext && (
              <div style={{
                padding: "4px 12px",
                fontSize: "0.78em",
                fontFamily: "monospace",
                color: "rgba(0, 230, 255, 0.85)",
                background: "rgba(0, 230, 255, 0.06)",
                borderTop: "1px solid rgba(0, 230, 255, 0.15)",
                borderBottom: "1px solid rgba(0, 230, 255, 0.15)",
                wordBreak: "break-all",
                lineHeight: 1.4,
              }}>
                {node.semanticContext}
              </div>
            )}

            {/* ─── Body: Deep Inspector ─── */}
            <div style={cardStyles.body}>
              {/* Ownership / Context */}
              {inspector?.ownership && (
                <InfoRow
                  label={isExec ? "Part of" : "In"}
                  value={inspector.ownership}
                  color={resolveColorForFlavor(isObject ? "class" : "function", null)}
                />
              )}

              {/* Accessor info for property observers */}
              {inspector?.accessorFor && (
                <InfoRow label="Accessor for" value={inspector.accessorFor} color="#E040FB" />
              )}

              {/* Target Hub Inspector */}
              {isTarget && (() => {
                const origin = node.origin;
                let category: string;
                let color: string;
                if (!origin) { category = "Internal Target"; color = "#80DEEA"; }
                else if (origin === "Apple") { category = "Apple SDK"; color = "#42A5F5"; }
                else if (origin.startsWith("http") || origin.endsWith(".git")) { category = "Remote Dependency"; color = "#FF9800"; }
                else if (origin.startsWith("/")) { category = "Local Dependency"; color = "#66BB6A"; }
                else { category = "External"; color = "#EF5350"; }
                return (
                  <>
                    <InfoRow label="Category" value={category} color={color} />
                    {origin && origin !== "Apple" && (
                      <InfoRow label="Origin" value={origin} color="rgba(255,255,255,0.6)" />
                    )}
                  </>
                );
              })()}

              {/* Object Inspector */}
              {isObject && inspector && (
                <>
                  {inspector.extends_ && (
                    <InfoRow label="Extends" value={inspector.extends_} color="#CE93D8" />
                  )}
                  <TagList items={inspector.implements_} color="#FFD54F" label="Implements" />

                  {(inspector.inits.length > 0 || inspector.deinits.length > 0) && (
                    <div style={sectionStyles.row}>
                      <span style={sectionStyles.label}>Lifecycle</span>
                      <div style={sectionStyles.tagWrap}>
                        {inspector.inits.map((name, i) => (
                          <span key={`init-${i}`} style={{ ...sectionStyles.tag, borderColor: "#AB47BC", color: "#AB47BC" }}>
                            {name}
                          </span>
                        ))}
                        {inspector.deinits.map((name, i) => (
                          <span key={`deinit-${i}`} style={{ ...sectionStyles.tag, borderColor: "#EF5350", color: "#EF5350" }}>
                            {name}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <TagList items={inspector.staticMethods} color="#42A5F5" label="Static" />
                  <TagList items={inspector.instanceMethods} color="#90CAF9" label="Methods" />
                  <ObserverList observers={inspector.observers} />
                  <TagList items={inspector.stores} color="#B0BEC5" label="Internal Storage" />
                </>
              )}

              {/* Defined In — extension locations for click-to-code navigation */}
              {isObject && node.locations && node.locations.length > 0 && (
                <div style={sectionStyles.row}>
                  <span style={sectionStyles.label}>Extensions</span>
                  <div style={sectionStyles.tagWrap}>
                    {node.locations.map((loc, i) => {
                      const fileName = loc.file.split("/").pop() ?? loc.file;
                      return (
                        <span
                          key={`loc-${i}`}
                          style={{
                            ...sectionStyles.tag,
                            borderColor: "#42A5F5",
                            color: "#42A5F5",
                            cursor: onOpenFile ? "pointer" : "default",
                          }}
                          onClick={() => onOpenFile?.({ file: loc.file, line: loc.line, col: loc.column })}
                        >
                          {fileName}:{loc.line}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Executable Body Inspector */}
              {isExec && inspector && (
                <TagList items={inspector.directCalls} color="#90CAF9" label="Calls" />
              )}

              {/* File Inspector */}
              {isFile && inspector && inspector.containsSymbols.length > 0 && (
                <div style={sectionStyles.row}>
                  <span style={sectionStyles.label}>Contains</span>
                  <div style={sectionStyles.tagWrap}>
                    {inspector.containsSymbols.map((sym, i) => {
                      const parts = sym.split(" ");
                      const flav = parts[0].toLowerCase();
                      return (
                        <span key={`sym-${i}`} style={{ ...sectionStyles.tag, borderColor: resolveColorForFlavor(flav, null), color: resolveColorForFlavor(flav, null) }}>
                          {sym}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Resource / Asset Inspector */}
              {isResource && inspector && inspector.referencedBy.length > 0 && (
                <div style={sectionStyles.row}>
                  <span style={sectionStyles.label}>Referenced by</span>
                  <div style={sectionStyles.tagWrap}>
                    {inspector.referencedBy.map((name, i) => (
                      <span key={`ref-${i}`} style={{ ...sectionStyles.tag, borderColor: "#42A5F5", color: "#42A5F5" }}>
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* General "Called by" for non-resource non-file nodes */}
              {!isResource && !isFile && inspector && inspector.referencedBy.length > 0 && (
                <div style={sectionStyles.row}>
                  <span style={sectionStyles.label}>Called by</span>
                  <div style={sectionStyles.tagWrap}>
                    {inspector.referencedBy.map((name, i) => (
                      <span key={`caller-${i}`} style={{ ...sectionStyles.tag, borderColor: "#90CAF9", color: "#90CAF9" }}>
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* File preview (image/text) */}
              {preview && preview.nodeId === node.id && (
                <>
                  {preview.previewType === "image" && (
                    <img src={preview.data} alt={preview.fileName} style={cardStyles.image} />
                  )}
                  {preview.previewType === "text" && (
                    <pre style={cardStyles.code}>{preview.data}</pre>
                  )}
                </>
              )}

              {/* Fallback: member count if no deep data */}
              {!isObject && !isExec && !isFile && !isResource && node.memberCount && node.memberCount > 0 && (
                <div style={cardStyles.memberInfo}>
                  {node.memberCount} members
                </div>
              )}
            </div>

            {/* ─── Footer ─── */}
            <div style={cardStyles.footer}>
              <span style={cardStyles.footerFile}>
                {node.sourceFile.split("/").pop() ?? node.sourceFile}
              </span>
              {node.targetName && (
                <span style={cardStyles.footerTarget}>{node.targetName}</span>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════════

const cardStyles: Record<string, React.CSSProperties> = {
  card: {
    position: "absolute",
    zIndex: 30,
    width: 280,
    background: "rgba(30, 30, 30, 0.92)",
    backdropFilter: "blur(16px)",
    WebkitBackdropFilter: "blur(16px)",
    border: "1px solid rgba(255, 255, 255, 0.08)",
    borderRadius: 10,
    overflow: "visible",
    boxShadow: "0 8px 32px rgba(0, 0, 0, 0.5), 0 0 1px rgba(255, 255, 255, 0.1)",
  },
  pointer: {
    position: "absolute" as const,
    width: 0,
    height: 0,
    borderLeft: "6px solid transparent",
    borderRight: "6px solid transparent",
    pointerEvents: "none" as const,
  },
  inner: {
    borderRadius: 10,
    overflow: "hidden",
    maxHeight: 380,
    overflowY: "auto" as const,
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px 8px",
    borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
  },
  icon: {
    fontSize: "1.3em",
    flexShrink: 0,
    width: 24,
    textAlign: "center" as const,
  },
  headerText: {
    minWidth: 0,
    flex: 1,
  },
  name: {
    fontSize: "0.85em",
    fontWeight: 600,
    color: "rgba(255, 255, 255, 0.92)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  type: {
    fontSize: "0.65em",
    color: "rgba(255, 255, 255, 0.45)",
    marginTop: 1,
  },
  body: {
    padding: "6px 12px 8px",
    display: "flex",
    flexDirection: "column" as const,
    gap: 4,
  },
  image: {
    width: "100%",
    maxHeight: 120,
    objectFit: "contain" as const,
    borderRadius: 6,
    background: "rgba(255, 255, 255, 0.03)",
    display: "block",
    marginTop: 4,
  },
  code: {
    fontSize: "0.6em",
    fontFamily: "var(--vscode-editor-font-family, monospace)",
    color: "rgba(255, 255, 255, 0.7)",
    background: "rgba(0, 0, 0, 0.3)",
    borderRadius: 6,
    padding: 8,
    margin: "4px 0 0",
    maxHeight: 100,
    overflow: "hidden",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    lineHeight: 1.5,
  },
  memberInfo: {
    fontSize: "0.75em",
    color: "rgba(255, 255, 255, 0.5)",
    textAlign: "center" as const,
    padding: "4px 0",
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "6px 12px 8px",
    borderTop: "1px solid rgba(255, 255, 255, 0.06)",
    gap: 8,
  },
  footerFile: {
    fontSize: "0.6em",
    color: "rgba(255, 255, 255, 0.3)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    flex: 1,
  },
  footerTarget: {
    fontSize: "0.55em",
    color: "rgba(255, 255, 255, 0.2)",
    flexShrink: 0,
  },
};

const sectionStyles: Record<string, React.CSSProperties> = {
  row: {
    display: "flex",
    flexDirection: "column" as const,
    gap: 3,
  },
  label: {
    fontSize: "0.6em",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "rgba(255, 255, 255, 0.35)",
  },
  tagWrap: {
    display: "flex",
    flexWrap: "wrap" as const,
    gap: 3,
  },
  tag: {
    fontSize: "0.65em",
    fontWeight: 500,
    padding: "1px 6px",
    borderRadius: 4,
    border: "1px solid",
    background: "rgba(255, 255, 255, 0.03)",
    whiteSpace: "nowrap" as const,
  },
  infoRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  infoLabel: {
    fontSize: "0.65em",
    color: "rgba(255, 255, 255, 0.4)",
    flexShrink: 0,
  },
  infoValue: {
    fontSize: "0.7em",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
    textAlign: "right" as const,
  },
};
