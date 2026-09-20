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
exports.discoverPlugins = discoverPlugins;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
function backendsCheckoutRoot() {
    return path.join(os.homedir(), "Documents", "Code", "code-prism", "backends");
}
function installedRoot() {
    return path.join(os.homedir(), "Library", "Application Support", "CodePrism", "backends");
}
function tryLoad(dir) {
    const manifestPath = path.join(dir, "code-prism-plugin.json");
    if (!fs.existsSync(manifestPath))
        return null;
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    }
    catch {
        return null;
    }
    const cacheFolder = manifest.cacheFolder ||
        (manifest.id === "objc" ? "objective-c-prism" : `${manifest.id}-prism`);
    const candidates = [
        path.join(dir, "bin", manifest.bin),
        path.join(dir, manifest.bin),
        path.join(dir, "core", ".build", "release", manifest.bin),
        path.join(installedRoot(), manifest.id, manifest.bin),
    ];
    const binaryPath = candidates.find((p) => {
        try {
            fs.accessSync(p, fs.constants.X_OK);
            return true;
        }
        catch {
            return fs.existsSync(p);
        }
    }) || path.join(dir, "bin", manifest.bin);
    return {
        id: manifest.id,
        name: manifest.name,
        bin: manifest.bin,
        extensions: (manifest.extensions || []).map((e) => e.toLowerCase()),
        markers: manifest.markers || [],
        cacheFolder,
        version: manifest.version || "0",
        root: dir,
        binaryPath,
    };
}
/** Discover plugins from Application Support + code-prism/backends/*-prism. */
function discoverPlugins() {
    const byId = new Map();
    const scanInstalled = installedRoot();
    if (fs.existsSync(scanInstalled)) {
        for (const id of fs.readdirSync(scanInstalled)) {
            const plugin = tryLoad(path.join(scanInstalled, id));
            if (plugin)
                byId.set(plugin.id, plugin);
        }
    }
    const scanCheckouts = backendsCheckoutRoot();
    if (fs.existsSync(scanCheckouts)) {
        for (const repo of fs.readdirSync(scanCheckouts)) {
            if (!repo.endsWith("-prism"))
                continue;
            const plugin = tryLoad(path.join(scanCheckouts, repo));
            if (!plugin)
                continue;
            const existing = byId.get(plugin.id);
            if (!existing || fs.existsSync(plugin.binaryPath)) {
                byId.set(plugin.id, plugin);
            }
        }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
//# sourceMappingURL=pluginDiscovery.js.map