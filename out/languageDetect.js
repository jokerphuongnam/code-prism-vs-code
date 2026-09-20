"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectLanguage = detectLanguage;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const SKIP = new Set([
    ".build", "DerivedData", "Pods", "node_modules", ".git", "Carthage",
    "dist", "target", ".next", ".turbo", "__pycache__", ".venv", "vendor",
]);
const EXT_LANG = {
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
};
/**
 * Auto-detect project language. Throws if none recognized.
 */
function detectLanguage(projectRoot) {
    const counts = {
        swift: 0,
        marlin: 0,
        kotlin: 0,
        js: 0,
        rust: 0,
        go: 0,
    };
    const markers = {};
    const bump = (lang, n, note) => {
        counts[lang] += n;
        if (note) {
            (markers[lang] ??= []).push(note);
        }
    };
    const markerFiles = [
        ["Package.swift", "swift", 50],
        ["go.mod", "go", 50],
        ["Cargo.toml", "rust", 50],
        ["build.gradle.kts", "kotlin", 50],
        ["build.gradle", "kotlin", 40],
        ["Application.marlin", "marlin", 50],
        ["package.json", "js", 40],
        ["tsconfig.json", "js", 45],
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
    }
    catch {
        /* ignore */
    }
    walk(projectRoot, (file) => {
        const ext = path.extname(file).slice(1).toLowerCase();
        const lang = EXT_LANG[ext];
        if (lang)
            counts[lang] += 1;
    });
    const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const best = ranked[0];
    if (!best || best[1] <= 0) {
        throw new Error(`Không nhận diện được ngôn ngữ trong “${path.basename(projectRoot)}”. ` +
            "Cần Swift / Marlin / Kotlin / JS·TS / Rust / Go.");
    }
    const notes = markers[best[0]] ?? [];
    const evidence = notes.length > 0
        ? `${notes.join(", ")} · score ${best[1]}`
        : `score ${best[1]} source files`;
    return { languageId: best[0], evidence, score: best[1] };
}
function walk(dir, onFile) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const e of entries) {
        if (SKIP.has(e.name) || e.name.startsWith("."))
            continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory())
            walk(p, onFile);
        else
            onFile(p);
    }
}
//# sourceMappingURL=languageDetect.js.map