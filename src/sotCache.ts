import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { discoverPlugins } from "./pluginDiscovery";

/** ~/Library/Caches/code-prism/<projectName>-<hash>/{lang}-prism/ */
export const CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "code-prism");

export function sanitizeProjectName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function projectHash(projectRoot: string): string {
  const real = fs.realpathSync(projectRoot);
  return crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
}

export function projectSlug(projectRoot: string): string {
  const real = fs.realpathSync(projectRoot);
  return `${sanitizeProjectName(path.basename(real))}-${projectHash(real)}`;
}

export function langPrismFolder(lang: string): string {
  const plugin = discoverPlugins().find((p) => p.id === lang);
  if (plugin?.cacheFolder) return plugin.cacheFolder;
  if (lang === "objc") return "objective-c-prism";
  if (lang.endsWith("-prism")) return lang;
  return `${lang}-prism`;
}

export function projectKey(projectRoot: string): string {
  return projectHash(projectRoot);
}

export function cacheDir(lang: string, projectRoot: string): string {
  return path.join(CACHE_ROOT, projectSlug(projectRoot), langPrismFolder(lang));
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
  ensureCacheDir(lang, projectRoot);
  const meta = {
    projectRoot: real,
    language: lang,
    projectSlug: projectSlug(projectRoot),
    projectKey: projectHash(projectRoot),
    generatedAt: new Date().toISOString(),
    sot: {
      json: contextJsonPath(lang, projectRoot),
      sqlite: sqlitePath(lang, projectRoot),
    },
    ...extra,
  };
  fs.writeFileSync(metaPath(lang, projectRoot), JSON.stringify(meta, null, 2));
}

export function resolveExistingContext(
  projectRoot: string,
  lang: string
): string | null {
  const p = contextJsonPath(lang, projectRoot);
  if (fs.existsSync(p)) return p;
  // legacy: code-prism/<lang>/<hash>/
  const legacy = path.join(CACHE_ROOT, lang, projectHash(projectRoot), "prism-context.json");
  if (fs.existsSync(legacy)) return legacy;
  for (const hidden of [".codeprism", ".swiftprism"]) {
    const inProj = path.join(projectRoot, hidden, "prism-context.json");
    if (fs.existsSync(inProj)) return inProj;
  }
  return null;
}
