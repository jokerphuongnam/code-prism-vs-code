import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PrismLang } from "./languageDetect";

/** System SoT cache — never inside the user workspace. */
export const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "code-prism");

export function projectKey(projectRoot: string): string {
  const real = fs.realpathSync(projectRoot);
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function cacheDir(lang: PrismLang | string, projectRoot: string): string {
  return path.join(CACHE_ROOT, lang, projectKey(projectRoot));
}

export function contextJsonPath(lang: string, projectRoot: string): string {
  return path.join(cacheDir(lang, projectRoot), "prism-context.json");
}

export function metaPath(lang: string, projectRoot: string): string {
  return path.join(cacheDir(lang, projectRoot), "meta.json");
}

export function sqlitePath(lang: string, projectRoot: string): string {
  return path.join(cacheDir(lang, projectRoot), "graph.sqlite");
}

export function ensureCacheDir(lang: string, projectRoot: string): string {
  const dir = cacheDir(lang, projectRoot);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeMeta(
  lang: string,
  projectRoot: string,
  extra: Record<string, unknown> = {}
): void {
  const real = fs.realpathSync(projectRoot);
  const dir = ensureCacheDir(lang, projectRoot);
  const meta = {
    projectRoot: real,
    language: lang,
    projectKey: projectKey(projectRoot),
    generatedAt: new Date().toISOString(),
    sot: {
      json: contextJsonPath(lang, projectRoot),
      sqlite: sqlitePath(lang, projectRoot),
    },
    ...extra,
  };
  fs.writeFileSync(metaPath(lang, projectRoot), JSON.stringify(meta, null, 2));
  void dir;
}

/** Resolve existing SoT JSON for this workspace + language. */
export function resolveExistingContext(
  projectRoot: string,
  lang: string
): string | null {
  const p = contextJsonPath(lang, projectRoot);
  if (fs.existsSync(p)) return p;
  // legacy in-workspace (read only)
  for (const hidden of [".codeprism", ".swiftprism"]) {
    const legacy = path.join(projectRoot, hidden, "prism-context.json");
    if (fs.existsSync(legacy)) return legacy;
  }
  return null;
}
