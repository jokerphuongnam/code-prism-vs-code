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
exports.detectAllLanguages = detectAllLanguages;
exports.detectLanguage = detectLanguage;
exports.pluginForLang = pluginForLang;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const pluginDiscovery_1 = require("./pluginDiscovery");
const SKIP = new Set([
    ".build", "DerivedData", "Pods", "node_modules", ".git", "Carthage",
    "dist", "target", ".next", ".turbo", "__pycache__", ".venv", "vendor",
]);
/** Detect languages from **installed/checked-out plugins** only. */
function detectAllLanguages(projectRoot) {
    const plugins = (0, pluginDiscovery_1.discoverPlugins)();
    if (plugins.length === 0) {
        throw new Error("Không tìm thấy backend plugin nào trên máy. Clone vào ~/Documents/Code/code-prism/backends/*-prism.");
    }
    const counts = new Map();
    const fileCounts = new Map();
    const markersHit = new Map();
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
            }
            catch { /* ignore */ }
        }
    }
    const extToLang = new Map();
    for (const plugin of plugins) {
        for (const ext of plugin.extensions) {
            if (!extToLang.has(ext))
                extToLang.set(ext, plugin.id);
        }
    }
    let headerCount = 0;
    walk(projectRoot, (file) => {
        const ext = path.extname(file).slice(1).toLowerCase();
        if (ext === "h")
            headerCount += 1;
        const lang = extToLang.get(ext);
        if (!lang)
            return;
        counts.set(lang, (counts.get(lang) || 0) + 1);
        fileCounts.set(lang, (fileCounts.get(lang) || 0) + 1);
    });
    if ((counts.get("objc") || 0) > 0 && headerCount > 0) {
        counts.set("objc", (counts.get("objc") || 0) + Math.min(headerCount, counts.get("objc") || 0));
    }
    const results = [];
    for (const plugin of plugins) {
        const score = counts.get(plugin.id) || 0;
        if (score <= 0)
            continue;
        const files = fileCounts.get(plugin.id) || 0;
        const notes = markersHit.get(plugin.id) || [];
        if (files === 0 && notes.length === 0)
            continue;
        if (files === 0 && score < 40)
            continue;
        const evidence = notes.length > 0
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
        throw new Error(`Không nhận diện được ngôn ngữ trong “${path.basename(projectRoot)}”. Plugin hiện có: ${names}.`);
    }
    return results;
}
function detectLanguage(projectRoot) {
    return detectAllLanguages(projectRoot)[0];
}
function pluginForLang(lang) {
    return (0, pluginDiscovery_1.discoverPlugins)().find((p) => p.id === lang);
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