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
exports.loadFlatEntriesFromSoT = loadFlatEntriesFromSoT;
const fs = __importStar(require("fs"));
/** Load SoT JSON (context v2 or flat nodes) → FlatMapEntry[] for the webview. */
function loadFlatEntriesFromSoT(jsonPath) {
    const raw = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    // Raw FlatMapEntry[] (swift analyzer mapping dump)
    if (Array.isArray(raw) && raw.length > 0 && raw[0]?.id) {
        return raw;
    }
    // Flat MCP / schema 4
    if (Array.isArray(raw?.nodes) && raw.nodes.length > 0) {
        return raw.nodes.map((n) => ({
            id: n.id,
            name: n.name ?? n.id,
            flavor: n.flavor ?? "type",
            location: {
                absPath: n.location?.absPath ?? "",
                line: n.location?.line ?? 0,
                col: n.location?.col ?? 0,
            },
            parents: n.parents ?? [],
            calls: n.calls ?? [],
            inits: n.inits,
            deinits: n.deinits,
            extends: n.extends ?? null,
            implements: n.implements,
            stores: n.stores,
            origin: n.origin,
        }));
    }
    // Context v2: files[].signatures + dependencyIndex
    if (Array.isArray(raw?.files)) {
        const entries = [];
        const seen = new Set();
        const depIndex = raw.dependencyIndex ?? {};
        for (const file of raw.files) {
            const filePath = file.path ?? "";
            for (const sig of file.signatures ?? []) {
                if (!sig?.id || seen.has(sig.id))
                    continue;
                seen.add(sig.id);
                const flavor = inferFlavor(sig.signature ?? "", sig.id);
                const deps = Array.isArray(sig.dependencies) ? sig.dependencies : [];
                // Users of this symbol from reverse index → treat as callers into calls? 
                // FlatMapEntry.calls = callees. dependencyIndex: key=dep, values=users means users depend on dep.
                // So for node id, callees ≈ its dependencies list.
                entries.push({
                    id: sig.id,
                    name: String(sig.id).split(".").pop() ?? sig.id,
                    flavor,
                    location: { absPath: filePath, line: sig.line ?? 0, col: 0 },
                    parents: parentOf(sig.id),
                    calls: deps,
                });
            }
        }
        // Ensure dependency targets exist as nodes
        for (const [dep, users] of Object.entries(depIndex)) {
            if (!seen.has(dep)) {
                seen.add(dep);
                entries.push({
                    id: dep,
                    name: dep,
                    flavor: "external",
                    location: { absPath: "", line: 0, col: 0 },
                    parents: [],
                    calls: [],
                });
            }
            for (const user of users) {
                const e = entries.find((x) => x.id === user);
                if (e) {
                    const calls = new Set(e.calls ?? []);
                    calls.add(dep);
                    e.calls = [...calls];
                }
            }
        }
        return entries;
    }
    throw new Error(`Unrecognized SoT schema in ${jsonPath}`);
}
function parentOf(id) {
    const i = id.lastIndexOf(".");
    if (i <= 0)
        return [];
    return [id.slice(0, i)];
}
function inferFlavor(signature, id) {
    const s = signature;
    if (s.includes("struct "))
        return "struct";
    if (s.includes("class "))
        return "class";
    if (s.includes("enum "))
        return "enum";
    if (s.includes("protocol ") || s.includes("interface "))
        return "protocol";
    if (s.includes("actor "))
        return "actor";
    if (s.includes("func ") || s.includes("function ") || s.includes("fun ") || s.includes("fn "))
        return "function";
    if (s.includes("var ") || s.includes("let "))
        return "variable";
    if (id.includes("."))
        return "function";
    return "type";
}
//# sourceMappingURL=sotLoader.js.map