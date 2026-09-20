import type { AnalysisResult } from "../protocol";

interface JsonPreviewProps {
  result: AnalysisResult | null;
}

export function JsonPreview({ result }: JsonPreviewProps) {
  if (!result) {
    return <div style={styles.empty}>No data. Run analysis first.</div>;
  }

  return (
    <pre style={styles.pre}>{JSON.stringify(result, null, 2)}</pre>
  );
}

const styles: Record<string, React.CSSProperties> = {
  empty: {
    textAlign: "center",
    padding: 32,
    opacity: 0.5,
  },
  pre: {
    background: "var(--vscode-editor-background)",
    color: "var(--vscode-editor-foreground)",
    fontFamily: "var(--vscode-editor-font-family)",
    fontSize: "var(--vscode-editor-font-size)",
    padding: 12,
    margin: 0,
    overflow: "auto",
    height: "100%",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
};
