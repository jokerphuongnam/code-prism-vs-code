import { useState } from "react";
import type { AnalysisResult } from "../protocol";
import type { ViewTab } from "../App";

interface HeaderProps {
  result: AnalysisResult | null;
  loading: boolean;
  onAnalyze: () => void;
  onViewRawJson: () => void;
  activeTab: ViewTab;
  onTabChange: (tab: ViewTab) => void;
  isLkg: boolean;
  hasResources: boolean;
  jsonLoading: boolean;
}

function IconButton({ icon, label, onClick, disabled, active }: {
  icon: string; label: string; onClick: () => void; disabled?: boolean; active?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-flex" }}>
      <button
        style={{
          ...s.iconBtn,
          opacity: disabled ? 0.3 : active ? 1 : 0.7,
          background: active ? "rgba(255,255,255,0.12)" : "transparent",
        }}
        onClick={onClick}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={label}
      >
        {icon}
      </button>
      {hovered && !disabled && (
        <div style={s.tooltip}>{label}</div>
      )}
    </div>
  );
}

export function Header({
  result, loading, onAnalyze, onViewRawJson, activeTab, onTabChange, isLkg, hasResources, jsonLoading,
}: HeaderProps) {
  const nodeCount = result?.nodes.length ?? 0;
  const linkCount = result?.links.length ?? 0;
  const resourceCount = result?.resources?.length ?? 0;

  return (
    <>
      <div style={s.actionBar}>
        <IconButton
          icon={loading ? "⏳" : "▶"}
          label={loading ? "Analyzing…" : "Analyze Project"}
          onClick={onAnalyze}
          disabled={loading}
        />
        <IconButton
          icon="📋"
          label="View Raw JSON"
          onClick={onViewRawJson}
          disabled={jsonLoading || loading}
        />
        <div style={s.divider} />
        <IconButton icon="🧊" label="3D Graph" onClick={() => onTabChange("graph")} active={activeTab === "graph"} />
        <IconButton icon="📝" label="JSON Preview" onClick={() => onTabChange("json")} active={activeTab === "json"} />
        {hasResources && (
          <IconButton icon="📖" label="Guide" onClick={() => onTabChange("guide")} active={activeTab === "guide"} />
        )}
      </div>

      {result && (
        <div style={s.statsBar}>
          <span style={s.statsText}>
            {nodeCount} nodes
            <span style={s.statsDot}>{"\u00B7"}</span>
            {linkCount} links
            {resourceCount > 0 && (
              <>
                <span style={s.statsDot}>{"\u00B7"}</span>
                {resourceCount} resources
              </>
            )}
            {isLkg && <span style={s.lkg}> (cached)</span>}
          </span>
        </div>
      )}
    </>
  );
}

const GLASS = {
  background: "rgba(30, 30, 30, 0.65)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 10,
  boxShadow: "0 4px 20px rgba(0, 0, 0, 0.35)",
};

const s: Record<string, React.CSSProperties> = {
  actionBar: {
    position: "absolute",
    top: 8,
    right: 50,
    zIndex: 20,
    display: "flex",
    alignItems: "center",
    gap: 2,
    padding: "3px 6px",
    ...GLASS,
  },
  iconBtn: {
    width: 30,
    height: 30,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: "0.85em",
    color: "rgba(255, 255, 255, 0.85)",
    background: "transparent",
    transition: "background 0.12s, opacity 0.12s",
    fontFamily: "var(--vscode-font-family)",
  },
  divider: {
    width: 1,
    height: 18,
    background: "rgba(255, 255, 255, 0.1)",
    margin: "0 4px",
  },
  tooltip: {
    position: "absolute",
    top: "100%",
    left: "50%",
    transform: "translateX(-50%)",
    marginTop: 6,
    padding: "3px 8px",
    fontSize: "0.65em",
    color: "rgba(255, 255, 255, 0.8)",
    whiteSpace: "nowrap" as const,
    pointerEvents: "none" as const,
    ...GLASS,
    borderRadius: 6,
  },
  statsBar: {
    position: "absolute",
    bottom: 8,
    left: 8,
    zIndex: 15,
    padding: "4px 10px",
    ...GLASS,
    borderRadius: 8,
  },
  statsText: {
    fontSize: "0.65em",
    color: "rgba(255, 255, 255, 0.5)",
    fontFamily: "var(--vscode-font-family)",
    letterSpacing: "0.02em",
  },
  statsDot: {
    margin: "0 5px",
    opacity: 0.3,
  },
  lkg: {
    color: "#FFD54F",
    fontStyle: "italic",
  },
};
