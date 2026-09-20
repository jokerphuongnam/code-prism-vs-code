import type { AnalysisPhase, ProgressInfo } from "../protocol";

interface StatusBarProps {
  progress: ProgressInfo;
}

const PHASE_LABELS: Record<AnalysisPhase, string> = {
  idle: "Ready",
  scanning: "Scanning files",
  targets: "Detecting targets",
  resources: "Scanning resources",
  macros: "Analyzing macros",
  resolving: "Resolving dependencies",
  encoding: "Encoding results",
  streaming: "Streaming data",
  semantic_context: "Processing Context...",
  complete: "Ready",
  error: "Error",
};

function phaseColor(phase: AnalysisPhase): string {
  switch (phase) {
    case "error":
      return "var(--vscode-errorForeground)";
    case "complete":
    case "idle":
      return "var(--vscode-testing-iconPassed, #66BB6A)";
    default:
      return "var(--vscode-progressBar-background, #4FC3F7)";
  }
}

function isActive(phase: AnalysisPhase): boolean {
  return phase !== "idle" && phase !== "complete" && phase !== "error";
}

export function StatusBar({ progress }: StatusBarProps) {
  const label = PHASE_LABELS[progress.phase];
  const showCount = progress.total > 0 && isActive(progress.phase);
  const pct =
    progress.total > 0
      ? Math.round((progress.processed / progress.total) * 100)
      : 0;

  return (
    <div style={styles.bar}>
      <div style={styles.left}>
        <span
          style={{
            ...styles.dot,
            background: phaseColor(progress.phase),
            animation: isActive(progress.phase) ? "pulse 1.2s ease-in-out infinite" : "none",
          }}
        />
        <span style={styles.label}>{label}</span>
        {showCount && (
          <span style={styles.count}>
            {progress.processed}/{progress.total} ({pct}%)
          </span>
        )}
      </div>
      {isActive(progress.phase) && (
        <div style={styles.progressTrack}>
          <div
            style={{
              ...styles.progressFill,
              width: progress.total > 0 ? `${pct}%` : "100%",
              animation:
                progress.total === 0
                  ? "indeterminate 1.5s ease-in-out infinite"
                  : "none",
            }}
          />
        </div>
      )}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        @keyframes indeterminate {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(200%); }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "4px 12px",
    borderTop: "1px solid var(--vscode-panel-border)",
    fontSize: "0.8em",
    flexShrink: 0,
    gap: 8,
  },
  left: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  label: {
    opacity: 0.8,
  },
  count: {
    opacity: 0.5,
  },
  progressTrack: {
    flex: 1,
    maxWidth: 120,
    height: 3,
    background: "var(--vscode-panel-border)",
    borderRadius: 2,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "var(--vscode-progressBar-background, #4FC3F7)",
    borderRadius: 2,
    transition: "width 0.3s ease",
  },
};
