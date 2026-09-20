import * as fs from "fs";
import * as path from "path";

export type PrismLang = "swift" | "marlin" | "kotlin" | "js" | "rust" | "go" | "cpp" | "objc";

export interface DetectResult {
  languageId: PrismLang;
  evidence: string;
  score: number;
}

const SKIP = new Set([
  ".build", "DerivedData", "Pods", "node_modules", ".git", "Carthage",
  "dist", "target", ".next", ".turbo", "__pycache__", ".venv", "vendor",
]);

const EXT_LANG: Record<string, PrismLang> = {
  swift: "swift",
  marlin: "marlin",
  kt: "kotlin",
  kts: "kotlin",
  js: "js",
  jsx: "js",
  ts: "js",
  tsx: "js",
  mjs: "js",
  cjs: "js",
  rs: "rust",
  go: "go",
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  h: "cpp",
  m: "objc",
  mm: "objc",
};

/**
 * Auto-detect project language. Throws if none recognized.
 */
export function detectLanguage(projectRoot: string): DetectResult {
  const counts: Record<PrismLang, number> = {
    swift: 0,
    marlin: 0,
    kotlin: 0,
    js: 0,
    rust: 0,
    go: 0,
    cpp: 0,
    objc: 0,
  };
  const markers: Partial<Record<PrismLang, string[]>> = {};

  const bump = (lang: PrismLang, n: number, note?: string) => {
    counts[lang] += n;
    if (note) {
      (markers[lang] ??= []).push(note);
    }
  };

  const markerFiles: [string, PrismLang, number][] = [
    ["Package.swift", "swift", 50],
    ["go.mod", "go", 50],
    ["Cargo.toml", "rust", 50],
    ["build.gradle.kts", "kotlin", 50],
    ["build.gradle", "kotlin", 40],
    ["Application.marlin", "marlin", 50],
    ["package.json", "js", 40],
    ["tsconfig.json", "js", 45],
    ["CMakeLists.txt", "cpp", 50],
    ["compile_commands.json", "cpp", 45],
  ];
  for (const [name, lang, score] of markerFiles) {
    if (fs.existsSync(path.join(projectRoot, name))) {
      bump(lang, score, name);
    }
  }

  try {
    for (const name of fs.readdirSync(projectRoot)) {
      if (name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace")) {
        bump("swift", 40, name);
      }
    }
  } catch {
    /* ignore */
  }

  walk(projectRoot, (file) => {
    const ext = path.extname(file).slice(1).toLowerCase();
    const lang = EXT_LANG[ext];
    if (lang) counts[lang] += 1;
  });

  const ranked = (Object.entries(counts) as [PrismLang, number][]).sort((a, b) => b[1] - a[1]);
  const best = ranked[0];
  if (!best || best[1] <= 0) {
    throw new Error(
      `Không nhận diện được ngôn ngữ trong “${path.basename(projectRoot)}”. ` +
        "Cần Swift / Marlin / Kotlin / JS·TS / Rust / Go / C++ / Objective-C."
    );
  }

  const notes = markers[best[0]] ?? [];
  const evidence =
    notes.length > 0
      ? `${notes.join(", ")} · score ${best[1]}`
      : `score ${best[1]} source files`;

  return { languageId: best[0], evidence, score: best[1] };
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
