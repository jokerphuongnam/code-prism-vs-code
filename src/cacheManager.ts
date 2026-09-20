import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";

const CACHE_DIR_NAME = "graph_cache";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NOINDEX_FILE = ".metadata_never_index";

export class CacheManager {
  private readonly cacheDir: string;

  constructor(globalStorageUri: vscode.Uri) {
    this.cacheDir = path.join(globalStorageUri.fsPath, CACHE_DIR_NAME);
    this.ensureDir();
  }

  resolveAnalysisPath(projectRoot: string): string {
    const hash = this.hashPath(projectRoot);
    return path.join(this.cacheDir, `${hash}_analysis.json`);
  }

  resolveContextPath(projectRoot: string): string {
    const hash = this.hashPath(projectRoot);
    return path.join(this.cacheDir, `${hash}_context.json`);
  }

  resolveMappingPath(projectRoot: string): string {
    const hash = this.hashPath(projectRoot);
    return path.join(this.cacheDir, `${hash}_mapping.json`);
  }

  cleanupWorkspaceArtifacts(workspaceRoot: string): number {
    const artifacts = ["prism-context.json", "swiftprism-config.json", "analysis_results.json", "mapping.json"];
    let cleaned = 0;
    for (const name of artifacts) {
      const filePath = path.join(workspaceRoot, name);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); cleaned++; } catch { /* skip */ }
      }
    }
    return cleaned;
  }

  clearAll(): number {
    if (!fs.existsSync(this.cacheDir)) return 0;
    const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try { fs.unlinkSync(path.join(this.cacheDir, f)); } catch { /* skip */ }
    }
    return files.length;
  }

  // TODO: Potential Redundant — pruneStale not currently called
  pruneStale(): number {
    if (!fs.existsSync(this.cacheDir)) return 0;
    const now = Date.now();
    let pruned = 0;
    const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const filePath = path.join(this.cacheDir, f);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(filePath);
          pruned++;
        }
      } catch { /* skip */ }
    }
    return pruned;
  }

  private hashPath(projectRoot: string): string {
    return crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
    const noindex = path.join(this.cacheDir, NOINDEX_FILE);
    if (!fs.existsSync(noindex)) {
      try { fs.writeFileSync(noindex, ""); } catch { /* skip */ }
    }
  }
}
