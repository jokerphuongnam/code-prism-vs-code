import { useState, useMemo } from "react";
import type { AnalysisResult, ResourceNode, LinkConfidence } from "../protocol";
import { confidenceColor, confidenceLabel } from "../design/theme";

interface GuideViewProps {
  result: AnalysisResult | null;
  onHighlight: (ids: Set<string>) => void;
  onCopyContext?: (nodeId: string) => void;
}

interface GuideSection {
  title: string;
  mentions: MentionedNode[];
}

interface MentionedNode {
  id: string;
  name: string;
  type: "symbol" | "resource" | "alias" | "heuristic";
  detail: string;
  confidence: LinkConfidence | null;
  relatedIds: string[];
}

function buildGuide(result: AnalysisResult): GuideSection[] {
  const sections: GuideSection[] = [];

  const typeSection: MentionedNode[] = result.nodes
    .filter((n) => ["struct", "class", "enum", "actor", "protocol"].includes(n.flavor))
    .map((n) => ({
      id: n.id,
      name: n.name,
      type: "symbol" as const,
      detail: `${n.flavor} (${n.access})`,
      confidence: null,
      relatedIds: [n.id],
    }));

  if (typeSection.length > 0) {
    sections.push({ title: "Types", mentions: typeSection });
  }

  const resourceSection: MentionedNode[] = result.resources.map((r) => ({
    id: r.id,
    name: r.name,
    type: "resource" as const,
    detail: `${r.resourceType.replace(/_/g, " ")}${r.catalogName ? ` in ${r.catalogName}` : ""}`,
    confidence: null,
    relatedIds: [r.id],
  }));

  if (resourceSection.length > 0) {
    sections.push({ title: "Resources", mentions: resourceSection });
  }

  const directLinks = result.links.filter((l) => l.type === "resource_link");
  if (directLinks.length > 0) {
    const resourceLinks: MentionedNode[] = directLinks.map((l) => {
      const sourceName = result.nodes.find((n) => n.id === l.source_id)?.name ?? l.source_id;
      const targetName = result.resources.find((r) => r.id === l.target_id)?.name ?? l.target_id;
      return {
        id: l.source_id,
        name: `${sourceName} → ${targetName}`,
        type: "resource" as const,
        detail: "direct reference",
        confidence: l.confidence,
        relatedIds: [l.source_id, l.target_id],
      };
    });
    sections.push({ title: "Resource Usage", mentions: resourceLinks });
  }

  const aliasLinks = result.links.filter((l) => l.type === "resource_alias");
  if (aliasLinks.length > 0) {
    const aliases: MentionedNode[] = aliasLinks.map((l) => {
      const sourceName = result.nodes.find((n) => n.id === l.source_id)?.name ?? l.source_id;
      const targetName = result.resources.find((r) => r.id === l.target_id)?.name ?? l.target_id;
      return {
        id: l.source_id,
        name: `${sourceName} ↔ ${targetName}`,
        type: "alias" as const,
        detail: "static property alias",
        confidence: l.confidence,
        relatedIds: [l.source_id, l.target_id],
      };
    });
    sections.push({ title: "Static Resource Aliases", mentions: aliases });
  }

  const heuristicLinks = result.links.filter((l) => l.type === "heuristic_link");
  if (heuristicLinks.length > 0) {
    const heuristics: MentionedNode[] = heuristicLinks.map((l) => {
      const sourceName = result.nodes.find((n) => n.id === l.source_id)?.name ?? l.source_id;
      const targetName = result.resources.find((r) => r.id === l.target_id)?.name ?? l.target_id;
      return {
        id: l.source_id,
        name: `${sourceName} ⇢ ${targetName}`,
        type: "heuristic" as const,
        detail: "heuristic match",
        confidence: l.confidence,
        relatedIds: [l.source_id, l.target_id],
      };
    });
    sections.push({ title: "Heuristic Matches", mentions: heuristics });
  }

  const markdowns = result.resources.filter((r) => r.resourceType === "markdown_file");
  if (markdowns.length > 0) {
    const mdNodes: MentionedNode[] = markdowns.map((r) => ({
      id: r.id,
      name: r.name,
      type: "resource" as const,
      detail: r.filePath.split("/").slice(-2).join("/"),
      confidence: null,
      relatedIds: [r.id],
    }));
    sections.push({ title: "Documentation", mentions: mdNodes });
  }

  return sections;
}

const TYPE_BADGE_COLORS: Record<MentionedNode["type"], string> = {
  symbol: "#7E57C2",
  resource: "#29B6F6",
  alias: "#5C6BC0",
  heuristic: "#FFB74D",
};

const TYPE_BADGE_LABELS: Record<MentionedNode["type"], string> = {
  symbol: "S",
  resource: "R",
  alias: "A",
  heuristic: "H",
};

export function GuideView({ result, onHighlight, onCopyContext }: GuideViewProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const guide = useMemo(() => (result ? buildGuide(result) : []), [result]);

  if (!result) {
    return <div style={styles.empty}>Run analysis to generate the interactive guide.</div>;
  }

  if (guide.length === 0) {
    return <div style={styles.empty}>No items to display.</div>;
  }

  const handleMouseEnter = (node: MentionedNode) => {
    setHoveredId(node.id);
    onHighlight(new Set([...node.relatedIds, node.name]));
  };

  const handleMouseLeave = () => {
    setHoveredId(null);
    onHighlight(new Set());
  };

  return (
    <div style={styles.container}>
      {guide.map((section) => (
        <div key={section.title} style={styles.section}>
          <h3 style={styles.sectionTitle}>{section.title}</h3>
          <div style={styles.nodeList}>
            {section.mentions.map((node, idx) => (
              <div
                key={`${section.title}-${node.id}-${idx}`}
                style={{
                  ...styles.nodeItem,
                  ...(hoveredId === node.id ? styles.nodeItemHovered : {}),
                }}
                onMouseEnter={() => handleMouseEnter(node)}
                onMouseLeave={handleMouseLeave}
              >
                <span
                  style={{
                    ...styles.typeBadge,
                    background: TYPE_BADGE_COLORS[node.type],
                  }}
                >
                  {TYPE_BADGE_LABELS[node.type]}
                </span>
                <div style={styles.nodeInfo}>
                  <div style={styles.nodeNameRow}>
                    <span style={styles.nodeName}>{node.name}</span>
                    {node.confidence && (
                      <span
                        style={{
                          ...styles.confidenceBadge,
                          background: confidenceColor(node.confidence),
                        }}
                      >
                        {confidenceLabel(node.confidence)}
                      </span>
                    )}
                  </div>
                  <span style={styles.nodeDetail}>{node.detail}</span>
                </div>
                {onCopyContext && node.type === "symbol" && (
                  <button
                    style={styles.copyBtn}
                    onClick={(e) => { e.stopPropagation(); onCopyContext(node.id); }}
                    title="Copy context for AI"
                  >
                    AI
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: 12,
    overflow: "auto",
    height: "100%",
  },
  empty: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    opacity: 0.5,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: "0.85em",
    fontWeight: 600,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    opacity: 0.6,
    marginBottom: 8,
    borderBottom: "1px solid var(--vscode-panel-border)",
    paddingBottom: 4,
  },
  nodeList: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
  },
  nodeItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    borderRadius: 4,
    cursor: "pointer",
    transition: "background 0.15s",
  },
  nodeItemHovered: {
    background: "var(--vscode-list-hoverBackground)",
  },
  typeBadge: {
    width: 20,
    height: 20,
    borderRadius: 4,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.7em",
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
  },
  nodeInfo: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    minWidth: 0,
    flex: 1,
  },
  nodeNameRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  nodeName: {
    fontSize: "0.9em",
    fontWeight: 500,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  confidenceBadge: {
    fontSize: "0.6em",
    fontWeight: 700,
    color: "#fff",
    borderRadius: 6,
    padding: "1px 5px",
    flexShrink: 0,
    textTransform: "uppercase" as const,
    letterSpacing: "0.03em",
  },
  nodeDetail: {
    fontSize: "0.75em",
    opacity: 0.5,
  },
  copyBtn: {
    background: "var(--vscode-button-secondaryBackground, #3A3D41)",
    color: "var(--vscode-button-secondaryForeground, #ccc)",
    border: "none",
    borderRadius: 4,
    padding: "2px 6px",
    cursor: "pointer",
    fontSize: "0.65em",
    fontWeight: 700,
    flexShrink: 0,
    opacity: 0.7,
  },
};
