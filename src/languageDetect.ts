import * as fs from "fs";
import * as path from "path";
import { discoverPlugins, type PrismPlugin } from "./pluginDiscovery";

export type PrismLang = string;

export interface DetectResult {
  languageId: string;
  evidence: string;
  score: number;
  sourceFileCount: number;
}

const SKIP = new Set([
  ".build", "DerivedData", "Pods", "node_modules", ".git", "Carthage",
  "dist", "target", ".next", ".turbo", "__pycache__", ".venv", "vendor",
]);

/** Detect languages from **installed/checked-out plugins** only. */
export function detectAllLanguages(projectRoot: string): DetectResult[] {
  const plugins = discoverPlugins();
  if (plugins.length === 0) {
    throw new Error(
      "Không tìm thấy backend plugin nào trên máy. Clone vào ~/Documents/Code/code-prism/backends/*-prism."
    );
  }

  const counts = new Map<string, number>();
  const fileCounts = new Map<string, number>();
  const markersHit = new Map<string, string[]>();
  for (const p of plugins) {
    counts.set(p.id, 0);
    fileCounts.set(p.id, 0);
  }

  for (const plugin of plugins) {
    for (const marker of plugin.markers) {
      if (fs.existsSync(path.join(projectRoot, marker))) {
        counts.set(plugin.id, (counts.get(plugin.id) || 0) + 50);
        const arr = markersHit.get(plugin.id) || [];
        arr.push(marker);
        markersHit.set(plugin.id, arr);
      }
    }
    if (plugin.extensions.includes("swift")) {
      try {
        for (const name of fs.readdirSync(projectRoot)) {
          if (name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace")) {
            counts.set(plugin.id, (counts.get(plugin.id) || 0) + 40);
            const arr = markersHit.get(plugin.id) || [];
            arr.push(name);
            markersHit.set(plugin.id, arr);
          }
        }
      } catch { /* ignore */ }
    }
  }

  const extToLang = new Map<string, string>();
  for (const plugin of plugins) {
    for (const ext of plugin.extensions) {
      if (!extToLang.has(ext)) extToLang.set(ext, plugin.id);
    }
  }

  let headerCount = 0;
  walk(projectRoot, (file) => {
    const ext = path.extname(file).slice(1).toLowerCase();
    if (ext === "h") headerCount += 1;
    const lang = extToLang.get(ext);
    if (!lang) return;
    counts.set(lang, (counts.get(lang) || 0) + 1);
    fileCounts.set(lang, (fileCounts.get(lang) || 0) + 1);
  });
  if ((counts.get("objc") || 0) > 0 && headerCount > 0) {
    counts.set("objc", (counts.get("objc") || 0) + Math.min(headerCount, counts.get("objc") || 0));
  }

  const results: DetectResult[] = [];
  for (const plugin of plugins) {
    const score = counts.get(plugin.id) || 0;
    if (score <= 0) continue;
    const files = fileCounts.get(plugin.id) || 0;
    const notes = markersHit.get(plugin.id) || [];
    if (files === 0 && notes.length === 0) continue;
    if (files === 0 && score < 40) continue;
    const evidence =
      notes.length > 0
        ? `${notes.join(", ")}${files > 0 ? ` · ${files} files` : ""}`
        : `${files} source files`;
    results.push({
      languageId: plugin.id,
      evidence,
      score,
      sourceFileCount: files,
    });
  }

  results.sort((a, b) => b.score - a.score);
  if (results.length === 0) {
    const names = plugins.map((p) => p.name).join(" / ");
    throw new Error(
      `Không nhận diện được ngôn ngữ trong “${path.basename(projectRoot)}”. Plugin hiện có: ${names}.`
    );
  }
  return results;
}

export function detectLanguage(projectRoot: string): DetectResult {
  return detectAllLanguages(projectRoot)[0];
}

export function pluginForLang(lang: string): PrismPlugin | undefined {
  return discoverPlugins().find((p) => p.id === lang);
}

function walk(dir: string, onFile: (f: string) => void): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, onFile);
    else onFile(p);
  }
}
