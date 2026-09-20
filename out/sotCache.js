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
exports.CACHE_ROOT = void 0;
exports.sanitizeProjectName = sanitizeProjectName;
exports.projectHash = projectHash;
exports.projectSlug = projectSlug;
exports.langPrismFolder = langPrismFolder;
exports.projectKey = projectKey;
exports.cacheDir = cacheDir;
exports.contextJsonPath = contextJsonPath;
exports.metaPath = metaPath;
exports.sqlitePath = sqlitePath;
exports.ensureCacheDir = ensureCacheDir;
exports.writeMeta = writeMeta;
exports.resolveExistingContext = resolveExistingContext;
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/** ~/Library/Caches/code-prism/<projectName>-<hash>/{lang}-prism/ */
exports.CACHE_ROOT = path.join(os.homedir(), "Library", "Caches", "code-prism");
function sanitizeProjectName(name) {
    return name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}
function projectHash(projectRoot) {
    const real = fs.realpathSync(projectRoot);
    return crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
}
function projectSlug(projectRoot) {
    const real = fs.realpathSync(projectRoot);
    return `${sanitizeProjectName(path.basename(real))}-${projectHash(real)}`;
}
function langPrismFolder(lang) {
    if (lang === "objc")
        return "objective-c-prism";
    if (lang.endsWith("-prism"))
        return lang;
    return `${lang}-prism`;
}
function projectKey(projectRoot) {
    return projectHash(projectRoot);
}
function cacheDir(lang, projectRoot) {
    return path.join(exports.CACHE_ROOT, projectSlug(projectRoot), langPrismFolder(lang));
}
function contextJsonPath(lang, projectRoot) {
    return path.join(cacheDir(lang, projectRoot), "prism-context.json");
}
function metaPath(lang, projectRoot) {
    return path.join(cacheDir(lang, projectRoot), "meta.json");
}
function sqlitePath(lang, projectRoot) {
    return path.join(cacheDir(lang, projectRoot), "graph.sqlite");
}
function ensureCacheDir(lang, projectRoot) {
    const dir = cacheDir(lang, projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function writeMeta(lang, projectRoot, extra = {}) {
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
function resolveExistingContext(projectRoot, lang) {
    const p = contextJsonPath(lang, projectRoot);
    if (fs.existsSync(p))
        return p;
    // legacy: code-prism/<lang>/<hash>/
    const legacy = path.join(exports.CACHE_ROOT, lang, projectHash(projectRoot), "prism-context.json");
    if (fs.existsSync(legacy))
        return legacy;
    for (const hidden of [".codeprism", ".swiftprism"]) {
        const inProj = path.join(projectRoot, hidden, "prism-context.json");
        if (fs.existsSync(inProj))
            return inProj;
    }
    return null;
}
//# sourceMappingURL=sotCache.js.map