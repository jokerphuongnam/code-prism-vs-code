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
exports.CacheManager = void 0;
const crypto = __importStar(require("crypto"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const CACHE_DIR_NAME = "graph_cache";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const NOINDEX_FILE = ".metadata_never_index";
class CacheManager {
    cacheDir;
    constructor(globalStorageUri) {
        this.cacheDir = path.join(globalStorageUri.fsPath, CACHE_DIR_NAME);
        this.ensureDir();
    }
    resolveAnalysisPath(projectRoot) {
        const hash = this.hashPath(projectRoot);
        return path.join(this.cacheDir, `${hash}_analysis.json`);
    }
    resolveContextPath(projectRoot) {
        const hash = this.hashPath(projectRoot);
        return path.join(this.cacheDir, `${hash}_context.json`);
    }
    resolveMappingPath(projectRoot) {
        const hash = this.hashPath(projectRoot);
        return path.join(this.cacheDir, `${hash}_mapping.json`);
    }
    cleanupWorkspaceArtifacts(workspaceRoot) {
        const artifacts = ["prism-context.json", "swiftprism-config.json", "analysis_results.json", "mapping.json"];
        let cleaned = 0;
        for (const name of artifacts) {
            const filePath = path.join(workspaceRoot, name);
            if (fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                    cleaned++;
                }
                catch { /* skip */ }
            }
        }
        return cleaned;
    }
    clearAll() {
        if (!fs.existsSync(this.cacheDir))
            return 0;
        const files = fs.readdirSync(this.cacheDir).filter((f) => f.endsWith(".json"));
        for (const f of files) {
            try {
                fs.unlinkSync(path.join(this.cacheDir, f));
            }
            catch { /* skip */ }
        }
        return files.length;
    }
    // TODO: Potential Redundant — pruneStale not currently called
    pruneStale() {
        if (!fs.existsSync(this.cacheDir))
            return 0;
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
            }
            catch { /* skip */ }
        }
        return pruned;
    }
    hashPath(projectRoot) {
        return crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
    }
    ensureDir() {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
        const noindex = path.join(this.cacheDir, NOINDEX_FILE);
        if (!fs.existsSync(noindex)) {
            try {
                fs.writeFileSync(noindex, "");
            }
            catch { /* skip */ }
        }
    }
}
exports.CacheManager = CacheManager;
//# sourceMappingURL=cacheManager.js.map