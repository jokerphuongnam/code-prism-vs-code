/**
 * ollamaBridge.ts — Entity-Aware Semantic Enrichment Pipeline
 *
 * Generates token-optimized `node_context` for every node flavor:
 *   - Functions:   f:name|i:intent|p:params|d:deps|s:side-effects
 *   - Classes:     c:name|resp:responsibility|state:fields|d:deps
 *   - Structs:     s:name|p:fields|i:data_purpose
 *   - Protocols:   i:name|contract:behaviors|req:methods
 *   - Extensions:  ext:OrigType|augments:capabilities
 *   - Enums:       e:name|cases:a,b,c|i:purpose
 *   - Targets/Libs: lib:name|role:project_role|usage:features
 *
 * Supports hierarchical context: parent nodes aggregate children's
 * collective purpose into a single high-level summary.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { FlatMapEntry } from "./analyzerBridge";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SemanticCacheEntry {
  hash: string;
  context: string;
  generatedAt: string;
}

export interface SemanticCache {
  version: string;
  entries: Record<string, SemanticCacheEntry>;
}

export interface ContextProgress {
  total: number;
  completed: number;
  cached: number;
  llmUsed: boolean;
}

export interface EnrichResult {
  enrichedCount: number;
  cachedCount: number;
  failedCount: number;
  llmUsed: boolean;
}

export interface EnrichCallbacks {
  onProgress?: (progress: ContextProgress) => void;
  onNodeEnriched?: (nodeId: string, context: string) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const OLLAMA_ENDPOINT = "http://localhost:11434";
const OLLAMA_MODEL = "mistral";
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_CONCURRENT = 3;
/**
 * Maximum lines to scan when extracting a node's source body.
 * Must be large enough to capture full class/function bodies — real-world
 * Swift entities routinely reach 200+ lines. Local LLMs (mistral/phi3) handle
 * 2-4K tokens of input well; 300 lines ≈ ~2K tokens, safely within context.
 */
const MAX_SOURCE_LINES = 300;

/** Every flavor that gets a semantic context — all entities including executables and targets */
const ELIGIBLE_FLAVORS = new Set([
  "function", "class", "struct", "enum", "actor", "protocol",
  "macro", "entry_point", "target", "variable", "initializer",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// UNIVERSAL SEMANTIC PROTOCOL (USP)
//
// A single prompt and tag vocabulary used for ALL node flavors.
// Designed for machine-to-machine density — any advanced LLM (Claude, GPT,
// Gemini, Codex) can reconstruct the full logic from these symbols.
//
// Tags:  t:(type/flavor)  i:(intent)  d:(deps)  s:(side-effects)
//        p:(params/props)  r:(returns/requirements)
// Delimiters:  | between fields,  , between list items
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * UDLF+ Relational-Aware prompt.
 *
 * KEY RULE: The node already has calls[], parents[], inits[], deinits[] fields.
 * DO NOT repeat those IDs in the context. Instead describe:
 *   - WHY/WHEN the calls happen (trigger conditions)
 *   - WHAT state changes internally
 *   - HOW side-effects propagate
 */
const USP_SYSTEM_PROMPT =
  "Distill this Swift code into a machine-to-machine logic flow.\n" +
  "Arrays (calls, inits, deinits, implements) are provided after the code.\n" +
  "Reference targets by TAGGED INDEX — never by name.\n\n" +
  "Tagged index notation:\n" +
  "  c[n]  = calls[n]      i[n]   = inits[n]\n" +
  "  di[n] = deinits[n]    imp[n] = implements[n]\n" +
  "Behavior prefixes:\n" +
  "  !c[n]  mandatory call    ?c[n]  conditional    ~>c[n] async\n" +
  "  !i[n]  mandatory init    !di[n] cleanup        imp[n] conformance\n" +
  "Use -> for sequence order within a lifecycle phase.\n\n" +
  "Other: ?(cond) ->(flow) @(state) $(return)\n" +
  "Type: t:c t:s t:e t:p t:a t:tg  Exec: f i di g st ws ds\n\n" +
  "Examples:\n" +
  "  e:ds|?chg->!c[0]|~>c[1]|@_intns\n" +
  "  f|?!=nil->!c[0]->@state|~>c[1]|$V|sync:main\n" +
  "  t:c|i:UI_Core|ini:!i[1]->i[0]|di:!di[0]|imp[0],imp[1]|sync:bg\n\n" +
  "Output: 1 line. Symbolic only. Use c[n]/i[n]/di[n]/imp[n] for all refs.\n";

/**
 * Build the user prompt for a target/library node (metadata only, no source).
 */
function buildLibraryPrompt(entry: FlatMapEntry, callerNames: string[]): string {
  const lines: string[] = [];
  lines.push(`Library: ${entry.name}`);
  if (entry.origin) lines.push(`Origin: ${entry.origin}`);
  if (entry.calls?.length) lines.push(`Depends on: ${entry.calls.slice(0, 5).join(", ")}`);
  if (callerNames.length > 0) lines.push(`Used by: ${callerNames.slice(0, 8).join(", ")}`);
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT HASHING
// ═══════════════════════════════════════════════════════════════════════════════

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE CONTENT CACHE
// ═══════════════════════════════════════════════════════════════════════════════

const fileContentCache = new Map<string, string[] | null>();

function getFileLines(absPath: string): string[] | null {
  if (fileContentCache.has(absPath)) return fileContentCache.get(absPath)!;
  try {
    const lines = fs.readFileSync(absPath, "utf-8").split("\n");
    fileContentCache.set(absPath, lines);
    return lines;
  } catch {
    fileContentCache.set(absPath, null);
    return null;
  }
}

export function clearFileCache(): void {
  fileContentCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SOURCE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract the full source code body for a node starting at the given line.
 * Uses brace-depth counting to find the matching closing brace.
 * If the body exceeds MAX_SOURCE_LINES, the source is truncated with a marker
 * so the LLM knows the code is incomplete.
 */
function extractSource(absPath: string, line: number): string | null {
  if (!absPath || line <= 0) return null;
  const lines = getFileLines(absPath);
  if (!lines) return null;
  const start = Math.max(0, line - 1);
  if (start >= lines.length) return null;

  let depth = 0;
  let foundOpen = false;
  let end = start;
  let complete = false;

  for (let i = start; i < Math.min(lines.length, start + MAX_SOURCE_LINES); i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") { depth--; }
    }
    end = i;
    if (foundOpen && depth <= 0) { complete = true; break; }
  }

  const source = lines.slice(start, end + 1).join("\n");
  if (!complete && foundOpen) {
    // Body was truncated — tell the LLM
    return source + `\n// ... truncated (${depth} open braces remaining, full body is ${countFullBody(lines, start)} lines)`;
  }
  return source;
}

/** Count the full body length without the MAX_SOURCE_LINES cap (for truncation info) */
function countFullBody(lines: string[], start: number): number {
  let depth = 0;
  let foundOpen = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") { depth--; }
    }
    if (foundOpen && depth <= 0) return i - start + 1;
  }
  return lines.length - start;
}

/**
 * For object nodes (class/struct/enum/actor/protocol), extract the primary
 * definition AND all extension blocks into a single merged source buffer.
 * This gives the LLM the Full Capability of the object, not just its core definition.
 *
 * Returns { merged, extensionCount } where extensionCount is how many
 * extension blocks were found (0 if none).
 */
function extractMergedObjectSource(
  entry: FlatMapEntry
): { merged: string | null; extensionCount: number } {
  // Primary definition
  const primary = extractSource(entry.location.absPath, entry.location.line);
  if (!entry.locations || entry.locations.length === 0) {
    return { merged: primary, extensionCount: 0 };
  }

  const blocks: string[] = [];
  if (primary) blocks.push(primary);

  // Each extension block
  for (const loc of entry.locations) {
    const extSrc = extractSource(loc.absPath, loc.line);
    if (extSrc) blocks.push(extSrc);
  }

  if (blocks.length === 0) return { merged: null, extensionCount: 0 };
  return {
    merged: blocks.join("\n\n// --- extension ---\n\n"),
    extensionCount: entry.locations.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// OLLAMA CLIENT
// ═══════════════════════════════════════════════════════════════════════════════

let _ollamaAvailable: boolean | null = null;

async function isOllamaAvailable(): Promise<boolean> {
  if (_ollamaAvailable !== null) return _ollamaAvailable;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: controller.signal });
    clearTimeout(timeout);
    _ollamaAvailable = res.ok;
  } catch {
    _ollamaAvailable = false;
  }
  return _ollamaAvailable;
}

export function resetOllamaCheck(): void {
  _ollamaAvailable = null;
}

async function queryOllama(systemPrompt: string, userPrompt: string): Promise<string | null> {
  const body = JSON.stringify({
    model: OLLAMA_MODEL,
    system: systemPrompt,
    prompt: userPrompt,
    stream: false,
    options: { temperature: 0.1, num_predict: 60 },
  });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const json = (await res.json()) as { response?: string };
    let text = json.response?.trim() ?? "";
    if (text.includes("\n")) text = text.split("\n")[0];
    if (text.length > 150) text = text.slice(0, 150);
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRUCTURAL FALLBACK — Entity-specific dense summaries
// ═══════════════════════════════════════════════════════════════════════════════

const OBJECT_FLAVORS = new Set(["class", "struct", "enum", "actor", "protocol"]);

/**
 * Ultra-Dense Logic Flow (UDLF) fallback generator.
 *
 * Produces flow-based notation using:
 *   ->  sequential flow         ?  condition/check
 *   !   mandatory/forced action @  state change
 *   $   return value            .  property access
 *
 * Format: [type_or_exec]|[logic_flow]
 */
function generateFallback(
  entry: FlatMapEntry,
  sourceCode: string | null,
  childContexts: string[],
  callerNames: string[],
  extensionCount: number = 0,
): string {
  const segments: string[] = [];

  // ── Prefix: type or exec tag ──
  const exec = inferExecTag(entry);
  if (exec) {
    segments.push(exec);
  } else {
    const TYPE_CODES: Record<string, string> = {
      class: "c", struct: "s", enum: "e", actor: "a", protocol: "p",
      macro: "m", target: "tg",
    };
    segments.push(`t:${TYPE_CODES[entry.flavor] ?? entry.flavor}`);
  }

  // ── Build the logic flow for this node ──
  if (OBJECT_FLAVORS.has(entry.flavor)) {
    segments.push(buildObjectFlow(entry, sourceCode, childContexts, extensionCount));
  } else if (entry.flavor === "target") {
    segments.push(buildTargetFlow(entry, callerNames));
  } else {
    segments.push(buildExecFlow(entry, sourceCode));
  }

  return segments.join("|");
}

/**
 * Build UDLF+ flow for an executable node.
 *
 * RELATIONAL-AWARE: Does NOT repeat IDs that already appear in calls[]/stores[].
 * Instead describes WHY/HOW: trigger conditions, guard clauses, state mutations.
 * The agent reads calls[] for "who", node_context for "why/how".
 */
function buildExecFlow(entry: FlatMapEntry, sourceCode: string | null): string {
  const execTag = inferExecTag(entry);
  const isAccessor = execTag === "ws" || execTag === "ds" || execTag === "g" || execTag === "st";
  const propName = isAccessor ? extractPropertyName(entry.name) : null;

  if (isAccessor && propName) {
    return buildAccessorFlow(execTag!, propName, sourceCode, entry);
  }

  // ── Standard function: use [n] index references for calls ──
  const flow: string[] = [];
  const callCount = entry.calls?.length ?? 0;

  // Guard clause — the condition that gates execution
  const guardClause = sourceCode ? detectGuardClause(sourceCode) : null;
  if (guardClause) {
    flow.push(`?${guardClause}->`);
  } else if (sourceCode && /\bif\s+let\b|\bif\s+\w/.test(sourceCode)) {
    flow.push("?cond->");
  }

  // Index-based call references: ![n] mandatory, ?[n] conditional, ~>[n] async
  if (callCount > 0) {
    // Classify each call by its invocation context from source code
    for (let ci = 0; ci < Math.min(callCount, 5); ci++) {
      const callName = (entry.calls![ci].split("::").pop() ?? "").toLowerCase();
      if (sourceCode) {
        // Check if this call is inside a guard/if block → conditional
        const isConditional = new RegExp(`if\\b.*\\b${escapeRegex(callName)}|guard.*\\b${escapeRegex(callName)}`, "i").test(sourceCode);
        // Check if this call is dispatched async
        const isAsync = new RegExp(`DispatchQueue.*\\b${escapeRegex(callName)}|Task\\s*\\{.*\\b${escapeRegex(callName)}`, "is").test(sourceCode);

        if (isAsync) flow.push(`~>c[${ci}]`);
        else if (isConditional) flow.push(`?c[${ci}]`);
        else flow.push(`!c[${ci}]`);
      } else {
        flow.push(`!c[${ci}]`);
      }
    }
  }

  // State mutations
  if (sourceCode) {
    const mutations = detectStateMutations(sourceCode);
    if (mutations) flow.push(`@${mutations}`);
  }

  // Return type
  const rets = entry.returns?.slice(0, 2);
  if (rets?.length) {
    flow.push(`$${rets.join(",")}`);
  } else if (sourceCode && /\breturn\b/.test(sourceCode)) {
    flow.push("$V");
  }

  // Intelligence annotations
  const intel = detectIntelligence(entry, sourceCode);
  if (intel) flow.push(`|${intel}`);

  return flow.join("") || (inferFunctionIntent(entry.name) ?? entry.name);
}

/**
 * Infer the execution order of call targets by their position in source code.
 * Returns array indices sorted by their first appearance line in the source.
 * Falls back to original array order if source is unavailable.
 */
function inferCallOrder(callIds: string[], sourceCode: string | null): number[] {
  const indices = callIds.map((_, i) => i);
  if (!sourceCode || callIds.length <= 1) return indices;

  // Find each call target's first occurrence position in source
  const positions: { idx: number; pos: number }[] = [];
  for (let idx = 0; idx < callIds.length; idx++) {
    const name = (callIds[idx].split("::").pop() ?? "").replace(/\(.*\)/, "");
    if (!name) { positions.push({ idx, pos: Infinity }); continue; }
    const pos = sourceCode.indexOf(name);
    positions.push({ idx, pos: pos >= 0 ? pos : Infinity });
  }

  // Sort by position (earlier in source = earlier in sequence)
  positions.sort((a, b) => a.pos - b.pos);
  return positions.map((p) => p.idx);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extract "intensity" from "intensity[willSet]" or "intensity[didSet]" (bracket convention) */
function extractPropertyName(name: string): string | null {
  // Bracket convention: intensity[didSet] → intensity
  const bracket = name.indexOf("[");
  if (bracket > 0) return name.substring(0, bracket);
  // Legacy dot convention: intensity.didSet → intensity
  const dot = name.lastIndexOf(".");
  if (dot > 0) return name.substring(0, dot);
  // Plain name (computed property)
  return name.toLowerCase() === "willset" || name.toLowerCase() === "didset" ? null : name;
}

/**
 * Build UDLF+ flow for accessors (willSet, didSet, get, set).
 *
 * RELATIONAL-AWARE: Does NOT repeat call targets (already in calls[]).
 * Describes the trigger condition, the "why" of the call, and state change.
 *
 * Examples:
 *   e:ds|?val_chg->!sync_UI|@_intns       (didSet: triggers on value change to sync UI)
 *   e:ws|?!=old->!pre_validate|@pending    (willSet: validates if different from old)
 *   e:g|$S                                  (getter: computes and returns String)
 */
function buildAccessorFlow(
  execTag: string,
  propName: string,
  sourceCode: string | null,
  entry: FlatMapEntry,
): string {
  const flow: string[] = [];

  const callCount = entry.calls?.length ?? 0;

  // Trigger condition + index-based call references
  if (execTag === "ws") {
    flow.push("?!=old->");
    for (let ci = 0; ci < Math.min(callCount, 3); ci++) flow.push(`!c[${ci}]`);
  } else if (execTag === "ds") {
    flow.push("?chg->");
    // didSet calls: reaction after the change — classify by source context
    for (let ci = 0; ci < Math.min(callCount, 3); ci++) {
      const callName = (entry.calls![ci].split("::").pop() ?? "").toLowerCase();
      const isAsync = sourceCode && new RegExp(`DispatchQueue.*${escapeRegex(callName)}|Task\\s*\\{.*${escapeRegex(callName)}`, "is").test(sourceCode);
      flow.push(isAsync ? `~>c[${ci}]` : `!c[${ci}]`);
    }
  } else if (execTag === "g") {
    // Getter: index refs for any computed dependencies + return
    for (let ci = 0; ci < Math.min(callCount, 2); ci++) flow.push(`?c[${ci}]`);
    const rets = entry.returns?.slice(0, 2);
    if (rets?.length) flow.push(`$${rets.join(",")}`);
    else flow.push("$V");
  } else if (execTag === "st") {
    flow.push("!assign");
    for (let ci = 0; ci < Math.min(callCount, 2); ci++) flow.push(`->c[${ci}]`);
  }

  // State mutation — what internal state changes
  const stateChange = inferAccessorStateChange(execTag, propName, [], sourceCode);
  if (stateChange) flow.push(`|@${stateChange}`);

  // Intelligence
  const intel = detectIntelligence(entry, sourceCode);
  if (intel) flow.push(`|${intel}`);

  return flow.join("") || propName;
}

/** Infer the state change caused by an accessor from its triggers and source */
function inferAccessorStateChange(
  execTag: string,
  propName: string,
  triggers: string[],
  sourceCode: string | null,
): string | null {
  // Name-based state inference
  const prop = propName.toLowerCase();
  if (/blur|effect|opacity|alpha/.test(prop)) return "blur_lvl";
  if (/color|theme|style/.test(prop)) return "appearance";
  if (/frame|bounds|size|position|origin/.test(prop)) return "layout";
  if (/text|title|label/.test(prop)) return "display";
  if (/state|status|phase|mode/.test(prop)) return "st_change";
  if (/count|total|sum/.test(prop)) return "metric";
  if (/enabled|disabled|active|visible|hidden/.test(prop)) return "ui_toggle";
  if (/selected|checked|on/.test(prop)) return "selection";
  if (/url|path|endpoint/.test(prop)) return "resource";
  if (/token|auth|session/.test(prop)) return "auth";

  // Source-based: if triggers contain UI-related calls
  if (triggers.some((t) => /layout|display|render|refresh|update.*ui|redraw/i.test(t))) return "ui_refresh";
  if (triggers.some((t) => /save|persist|write|store/i.test(t))) return "persist";
  if (triggers.some((t) => /notify|post|send|delegate/i.test(t))) return "notify";
  if (triggers.some((t) => /connect|disconnect|reconnect/i.test(t))) return "conn";

  // Generic: "propName changed"
  return `${propName}_chg`;
}

/**
 * Build UDLF+ flow for an object node.
 *
 * RELATIONAL-AWARE: Does NOT repeat extends/implements/calls (already in node fields).
 * Describes: intent, init side-effects, deinit cleanup, accessor behaviors, extensions.
 */
function buildObjectFlow(
  entry: FlatMapEntry,
  sourceCode: string | null,
  childContexts: string[],
  extensionCount: number,
): string {
  const flow: string[] = [];

  // Intent — the object's responsibility (not its deps)
  const intent = inferIntent(entry, childContexts, []);
  if (intent) flow.push(`i:${intent}`);

  // Init — sequence-ordered i[n] refs + behavior descriptors
  const lifecycle = analyzeLifecycle(entry, sourceCode);
  {
    const iniParts: string[] = [];
    if (entry.inits?.length) {
      // Try to determine execution order from source code positions
      const ordered = inferCallOrder(entry.inits, sourceCode);
      for (const idx of ordered) {
        iniParts.push(iniParts.length === 0 ? `!i[${idx}]` : `->i[${idx}]`);
      }
    }
    // Behavior descriptors from source analysis
    if (lifecycle.ini) {
      for (const b of lifecycle.ini.split(",")) {
        if (b === "add_observers") iniParts.push("bind_obs");
        else if (b === "conn_remote") iniParts.push("conn");
        else if (b === "start_timer") iniParts.push("sched");
        else if (b === "configures_defaults") iniParts.push("cfg");
      }
    }
    if (iniParts.length > 0) flow.push(`ini:${iniParts.join("")}`);
  }

  // Deinit — tagged index refs di[n] + cleanup descriptors from source
  {
    const diParts: string[] = [];
    if (entry.deinits?.length) {
      for (let n = 0; n < Math.min(entry.deinits.length, 3); n++) diParts.push(`!di[${n}]`);
    }
    if (lifecycle.di) {
      const cleanups = lifecycle.di.split(",").filter((p) =>
        ["cancel_tasks", "remove_observers", "close_conn", "stop_timer", "release_refs", "cleanup"].includes(p)
      );
      for (const c of cleanups) {
        if (c === "cancel_tasks") diParts.push("clr_tasks");
        else if (c === "remove_observers") diParts.push("clr_obs");
        else if (c === "close_conn") diParts.push("clr_conn");
        else if (c === "stop_timer") diParts.push("clr_timer");
        else if (c === "release_refs") diParts.push("clr_refs");
        else diParts.push(c);
      }
    }
    if (diParts.length > 0) flow.push(`di:${diParts.join(",")}`);
  }

  // imp[n] — protocol conformances by tagged index
  if (entry.implements?.length) {
    const impRefs = entry.implements.slice(0, 4).map((_, n) => `imp[${n}]`);
    flow.push(impRefs.join(","));
  }

  // Accessor summary — describes reactive behavior, not call targets
  const accSummary = summarizeAccessors(childContexts);
  if (accSummary) flow.push(`acc:${accSummary}`);

  // Extensions — describes capabilities added
  if (extensionCount > 0 && sourceCode) {
    const extCaps = inferExtensionCapabilities(sourceCode);
    if (extCaps) flow.push(`ext:${extCaps}`);
  }

  // Intelligence annotations (sync, cost, err, pattern)
  const intel = detectIntelligence(entry, sourceCode);
  if (intel) flow.push(intel);

  // Hub/leaf (graph topology, not in any other field)
  const callCount = (entry.calls?.length ?? 0) + (entry.inits?.length ?? 0);
  if (callCount >= 8) flow.push("hub");
  else if (callCount === 0 && !entry.stores?.length) flow.push("leaf");

  return flow.join("|");
}

/** Build UDLF+ flow for a target/library node — intent + extension capabilities only */
function buildTargetFlow(entry: FlatMapEntry, callerNames: string[]): string {
  const flow: string[] = [];
  const intent = inferIntent(entry, [], callerNames);
  if (intent) flow.push(`i:${intent}`);

  // For internal targets: describe what kinds of things it contains (from callers)
  if (!entry.origin && callerNames.length > 0) {
    flow.push(`@scope:${callerNames.length}users`);
  }

  // External: describe integration point
  if (entry.origin && entry.origin !== "Apple" && entry.origin !== "") {
    flow.push("ext:third_party");
  }

  if (callerNames.length >= 5) flow.push("hub");
  return flow.join("|") || entry.name;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UDLF+ INTELLIGENCE DETECTORS
// ═══════════════════════════════════════════════════════════════════════════════

/** Detect what internal state this code mutates (without naming call targets) */
function detectStateMutations(sourceCode: string): string | null {
  const mutations: string[] = [];
  // self.property = ... patterns
  if (/self\.\w+\s*=\s*[^=]/.test(sourceCode)) mutations.push("self_state");
  // @State/@Published mutations
  if (/@Published\b|@State\b/.test(sourceCode) && /\.\w+\s*=/.test(sourceCode)) mutations.push("reactive_state");
  // Array/collection mutations
  if (/\.append\(|\.remove|\.insert|\.replaceSubrange/.test(sourceCode)) mutations.push("collection");
  // Counter/numeric increments
  if (/\+=\s*\d|\-=\s*\d|\.toggle\(\)/.test(sourceCode)) mutations.push("counter");
  // UserDefaults/persistence
  if (/UserDefaults.*set\(|\.setValue\(/.test(sourceCode)) mutations.push("persist");
  return mutations.length > 0 ? mutations.join(",") : null;
}

/** Extract what a guard clause protects — returns the condition or null */
function detectGuardClause(sourceCode: string): string | null {
  // guard let x = ... else { return }
  const guardLet = sourceCode.match(/guard\s+let\s+(\w+)/);
  if (guardLet) return `${guardLet[1]}!=nil`;

  // guard x != nil / guard !x.isEmpty / guard x > 0
  const guardCond = sourceCode.match(/guard\s+(\w+(?:\.\w+)?)\s*(!?=\s*\w+|\.isEmpty|[><=]\s*\d+)/);
  if (guardCond) return `${guardCond[1]}${guardCond[2]}`.replace(/\s+/g, "");

  // Generic guard presence
  if (/\bguard\b/.test(sourceCode)) return "precond";
  return null;
}

/** Detect notification/KVO/delegate propagation chains */
function detectPropagation(sourceCode: string): string | null {
  if (/NotificationCenter.*\.post\(/.test(sourceCode)) return "notification";
  if (/delegate\?\.\w+|delegate\./.test(sourceCode)) return "delegate";
  if (/\$\w+\.send\(|objectWillChange/.test(sourceCode)) return "publisher";
  if (/\.publisher\b|\.sink\b|\.assign\b/.test(sourceCode)) return "combine";
  if (/setNeedsLayout|setNeedsDisplay|layoutIfNeeded/.test(sourceCode)) return "layout";
  return null;
}

/**
 * Detect intelligence annotations from source code and entry metadata.
 * Returns a pipe-joined string of: err: sync: cost: p: @effects ⚠risks
 */
function detectIntelligence(entry: FlatMapEntry, sourceCode: string | null): string | null {
  const parts: string[] = [];

  if (!sourceCode) {
    // Metadata-only intelligence
    if (entry.flavor === "actor") parts.push("sync:actor");
    return parts.length > 0 ? parts.join("|") : null;
  }

  // err: — error handling strategy
  if (/\bcatch\b.*\bretry\b|\bretry\b.*\bcatch\b/i.test(sourceCode)) parts.push("err:retry");
  else if (/\bthrow\b|\bthrows\b/.test(sourceCode)) parts.push("err:throw");
  else if (/\btry\?\s/.test(sourceCode)) parts.push("err:silent");
  else if (/\btry!\s/.test(sourceCode)) parts.push("err:force⚠");

  // sync: — concurrency context
  if (entry.flavor === "actor") {
    parts.push("sync:actor");
  } else if (/DispatchQueue\.main|@MainActor|MainActor\.run/.test(sourceCode)) {
    parts.push("sync:main");
  } else if (/DispatchQueue\.global|\.background|\.utility|\.userInitiated/.test(sourceCode)) {
    parts.push("sync:bg");
  } else if (/\basync\b|\bawait\b|Task\s*\{/.test(sourceCode)) {
    parts.push("sync:async");
  }

  // ⚠ risk: UI update from non-main thread
  if (/DispatchQueue\.global|\.background|sync:bg/.test(sourceCode)) {
    if (/UILabel|UIView|\.text\s*=|setNeedsLayout|@Published/.test(sourceCode)) {
      parts.push("⚠:ui_off_main");
    }
  }

  // cost: — computational cost estimation
  if (/\bfor\b.*\bin\b.*\bfor\b.*\bin\b/s.test(sourceCode)) parts.push("cost:H"); // nested loops
  else if (/\.sorted\(|\.filter\(.*\.map\(|\.reduce\(/.test(sourceCode)) parts.push("cost:M");
  else parts.push("cost:L");

  // p: — design pattern detection
  if (/shared\s*[:=]|\.shared\b|static\s+let\s+\w+\s*[:=]\s*\w+\(\)/.test(sourceCode)) parts.push("p:singleton");
  else if (/delegate\??\.|\bDelegate\b.*protocol/.test(sourceCode)) parts.push("p:delegate");
  else if (/NotificationCenter|\.addObserver|@Published|\.sink\b/.test(sourceCode)) parts.push("p:observer");
  else if (/func\s+make\w+|static\s+func\s+create/.test(sourceCode)) parts.push("p:factory");
  else if (/\.build\(\)|Builder\b/.test(sourceCode)) parts.push("p:builder");

  // @ state-change effects (kept from original)
  const effects: string[] = [];
  if (/URLSession|URLRequest|\.fetch/i.test(sourceCode)) effects.push("net");
  if (/FileManager|write\(/i.test(sourceCode)) effects.push("disk");
  if (/UserDefaults|CoreData/i.test(sourceCode)) effects.push("state");
  if (/UIView|SwiftUI|@Published/i.test(sourceCode)) effects.push("ui");
  if (effects.length > 0) parts.push(`@${effects.join(",")}`);

  return parts.length > 0 ? parts.join("|") : null;
}

/**
 * Summarize accessor behaviors (willSet/didSet/computed) from children contexts.
 * Extracts e:ws, e:ds, e:g entries and their intents to give the parent
 * a clear signal of its reactive property behavior.
 */
/**
 * Summarize accessor reactive chains from children's UDLF+ contexts.
 * Child context format: "ws|r:old?!=new->tr:validate!->@pending"
 * Extracts: exec tag + state change or trigger for compact parent summary.
 */
function summarizeAccessors(childContexts: string[]): string | null {
  const accessors: string[] = [];
  for (const ctx of childContexts) {
    // Match accessor prefixes: ws|..., ds|..., g|..., st|...
    const execMatch = ctx.match(/^(ws|ds|g|st)\|/);
    if (!execMatch) continue;

    const tag = execMatch[1];
    // Extract state change: @something
    const stateMatch = ctx.match(/@(\w+)/);
    // Extract trigger: tr:something
    const trigMatch = ctx.match(/tr:([^|!>,]+)/);

    if (stateMatch) {
      accessors.push(`${tag}->@${stateMatch[1]}`);
    } else if (trigMatch) {
      accessors.push(`${tag}->tr:${trigMatch[1]}`);
    } else {
      accessors.push(tag);
    }
  }
  return accessors.length > 0 ? accessors.slice(0, 4).join(",") : null;
}

/**
 * Determine the executable sub-tag for function-like nodes.
 * Returns null for type-level nodes (class, struct, etc.) — they get t: instead.
 *
 * Supports both bracket convention (intensity[didSet]) and legacy dot (intensity.didSet).
 */
function inferExecTag(entry: FlatMapEntry): string | null {
  const name = entry.name.toLowerCase();

  // Variable flavor — infer accessor type from name
  if (entry.flavor === "variable") {
    if (name === "willset" || name.endsWith("[willset]") || name.endsWith(".willset")) return "ws";
    if (name === "didset" || name.endsWith("[didset]") || name.endsWith(".didset")) return "ds";
    if (name === "getter" || name.endsWith("[get]") || name.endsWith(".get")) return "g";
    if (name === "setter" || name.endsWith("[set]") || name.endsWith(".set")) return "st";
    // Computed property (variable with executable body but no specific accessor)
    return "g";
  }

  // Initializer flavor
  if (entry.flavor === "initializer") return "i";

  // Function-like flavors
  if (entry.flavor === "function") {
    if (name === "deinit") return "di";
    return "f";
  }
  if (entry.flavor === "entry_point") return "f";

  // Not an executable — caller should use t: tag
  return null;
}

/**
/**
 * Analyze init/deinit lifecycle — RELATIONAL-AWARE.
 * Returns only behavior descriptors, NEVER call target names.
 * The agent reads inits[]/deinits[] for "who", this for "what side-effects".
 */
function analyzeLifecycle(
  entry: FlatMapEntry,
  sourceCode: string | null,
): { ini: string | null; di: string | null } {
  let ini: string | null = null;
  let di: string | null = null;

  // ── Init analysis — describe WHAT happens, not WHO is called ──
  const hasInits = entry.inits && entry.inits.length > 0;
  if (hasInits || sourceCode) {
    const initTraits: string[] = [];

    if (hasInits) {
      // Classify: does init just assign or does it trigger real logic?
      const initDeps = entry.inits!.map(leafName);
      const callsExternal = initDeps.some(
        (d) => !["self", "super"].includes(d.toLowerCase())
      );
      initTraits.push(callsExternal ? "triggers_logic" : "assign_only");
      // DO NOT push initDeps names — they're already in inits[]
    }

    // Source-level init pattern detection
    if (sourceCode && /init\s*\(/.test(sourceCode)) {
      if (!hasInits) initTraits.push("assign_only");
      if (/NotificationCenter.*addObserver|\.observe\(/.test(sourceCode)) initTraits.push("add_observers");
      if (/URLSession|connect|socket|\.start\(\)/i.test(sourceCode)) initTraits.push("conn_remote");
      if (/Timer\.|DispatchSource|schedule/i.test(sourceCode)) initTraits.push("start_timer");
      if (/UserDefaults|\.register\(defaults/i.test(sourceCode)) initTraits.push("configures_defaults");
      if (/super\.init/.test(sourceCode)) initTraits.push("calls_super");
    }

    if (initTraits.length > 0) ini = [...new Set(initTraits)].slice(0, 4).join(",");
  }

  // ── Deinit analysis — describe WHAT is cleaned up, not WHO is called ──
  if (entry.flavor === "class" || entry.flavor === "actor") {
    const deinitTraits: string[] = [];
    // DO NOT push deinit call target names — they're already in deinits[]

    if (sourceCode && /deinit\s*\{/.test(sourceCode)) {
      if (/cancel\(\)|\.cancel\b/i.test(sourceCode)) deinitTraits.push("cancel_tasks");
      if (/removeObserver|NotificationCenter.*remove/i.test(sourceCode)) deinitTraits.push("remove_observers");
      if (/close\(\)|disconnect|\.stop\(\)/i.test(sourceCode)) deinitTraits.push("close_conn");
      if (/invalidate\(\)|Timer.*invalidate/i.test(sourceCode)) deinitTraits.push("stop_timer");
      if (/nil\b.*=|= nil/i.test(sourceCode)) deinitTraits.push("release_refs");
      if (deinitTraits.length === 0) deinitTraits.push("cleanup");
    }

    if (deinitTraits.length > 0) di = [...new Set(deinitTraits)].slice(0, 4).join(",");
  }

  return { ini, di };
}

/** Infer intent from node name, children intents, or library role */
function inferIntent(
  entry: FlatMapEntry,
  childContexts: string[],
  callerNames: string[],
): string | null {
  // Executables (functions, variables, initializers) — infer from name
  if (!OBJECT_FLAVORS.has(entry.flavor) && entry.flavor !== "target") {
    // Special cases for accessors and lifecycle
    const name = entry.name.toLowerCase();
    if (name === "willset" || name.endsWith("[willset]") || name.endsWith(".willset")) return "validate_before_set";
    if (name === "didset" || name.endsWith("[didset]") || name.endsWith(".didset")) return "react_after_set";
    if (name === "deinit") return "cleanup";
    if (entry.flavor === "initializer" || name === "init" || name.startsWith("init(")) return "initialize";
    return inferFunctionIntent(entry.name);
  }

  // Objects — aggregate children intents into a responsibility summary
  if (OBJECT_FLAVORS.has(entry.flavor) && childContexts.length > 0) {
    const intents = extractTokensFromContexts(childContexts, "i:");
    if (intents.length > 0) return intents.slice(0, 3).join(",");
  }

  // Objects without children — infer from name
  if (OBJECT_FLAVORS.has(entry.flavor)) {
    return inferStructPurpose(entry.name) ?? inferEnumPurpose(entry.name) ?? null;
  }

  // Targets — infer from origin
  if (entry.flavor === "target") {
    if (!entry.origin) return "internal_module";
    if (entry.origin === "Apple") return inferAppleFrameworkRole(entry.name);
    return "third_party";
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS for fallback generation
// ═══════════════════════════════════════════════════════════════════════════════

function leafName(id: string): string {
  return id.split("::").pop() ?? id;
}

/** Extract specific token values (e.g. "i:read") from an array of context strings */
function extractTokensFromContexts(contexts: string[], prefix: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const ctx of contexts) {
    for (const segment of ctx.split("|")) {
      if (segment.startsWith(prefix)) {
        const val = segment.slice(prefix.length);
        if (val && !seen.has(val)) { seen.add(val); results.push(val); }
      }
    }
  }
  return results;
}

function inferFunctionIntent(name: string): string | null {
  const n = name.toLowerCase();
  if (/^(get|fetch|load|read|query|find|search|retrieve)/.test(n)) return "read";
  if (/^(set|update|save|write|store|put|patch|modify)/.test(n)) return "write";
  if (/^(create|make|build|init|new|generate|produce)/.test(n)) return "create";
  if (/^(delete|remove|drop|destroy|clear|reset|purge)/.test(n)) return "delete";
  if (/^(render|draw|display|show|present|layout)/.test(n)) return "render";
  if (/^(validate|check|verify|assert|ensure|guard)/.test(n)) return "validate";
  if (/^(configure|setup|register|bind|connect|attach)/.test(n)) return "setup";
  if (/^(handle|on[A-Z]|did|will|process|respond)/.test(n)) return "handle";
  if (/^(parse|decode|encode|serialize|transform|convert|map)/.test(n)) return "transform";
  if (/^(test|spec|assert|expect)/.test(n)) return "test";
  return null;
}

function inferStructPurpose(name: string): string | null {
  const n = name.toLowerCase();
  if (/config|setting|option|preference/.test(n)) return "configuration";
  if (/request|response|payload|body/.test(n)) return "data_transfer";
  if (/model|entity|record|data|info/.test(n)) return "data_model";
  if (/state|view.*state|ui.*state/.test(n)) return "state_container";
  if (/error|failure/.test(n)) return "error_type";
  if (/result|outcome/.test(n)) return "result_wrapper";
  return null;
}

function inferEnumPurpose(name: string): string | null {
  const n = name.toLowerCase();
  if (/route|screen|destination|page|tab/.test(n)) return "navigation";
  if (/state|status|phase/.test(n)) return "state_machine";
  if (/error|failure|issue/.test(n)) return "error_cases";
  if (/action|event|intent|command/.test(n)) return "action_dispatch";
  if (/type|kind|category|style|variant/.test(n)) return "classification";
  return null;
}

/**
 * Scan merged source (containing extension blocks after "// --- extension ---" markers)
 * to infer what capabilities the extensions add to the base type.
 */
function inferExtensionCapabilities(mergedSource: string): string | null {
  // Only scan the extension portions (after the marker)
  const extParts = mergedSource.split("// --- extension ---");
  if (extParts.length <= 1) return null;

  const extSource = extParts.slice(1).join("\n");
  const capabilities: string[] = [];

  // Conformance patterns (extension Foo: Protocol)
  const conformMatch = extSource.match(/extension\s+\w+\s*:\s*([\w,\s]+)\s*\{/g);
  if (conformMatch) {
    for (const m of conformMatch) {
      const protocols = m.match(/:\s*([\w,\s]+)\s*\{/);
      if (protocols) {
        for (const p of protocols[1].split(",").map(s => s.trim()).filter(Boolean)) {
          if (!capabilities.includes(p)) capabilities.push(p);
        }
      }
    }
  }

  // Pattern-based capability detection
  if (/func\s+tableView|func\s+collectionView|func\s+numberOfRows|UITableView|UICollectionView/.test(extSource)) capabilities.push("table_data_source");
  if (/func\s+textField|UITextFieldDelegate|func\s+textView/.test(extSource)) capabilities.push("text_input");
  if (/@objc\s+func|#selector|@IBAction/.test(extSource)) capabilities.push("objc_actions");
  if (/Codable|Decodable|Encodable|func\s+encode\(|init\(from\s+decoder/.test(extSource)) capabilities.push("coding");
  if (/Equatable|Hashable|Comparable|func\s+==\s*\(/.test(extSource)) capabilities.push("equality");
  if (/CustomStringConvertible|description\s*:/.test(extSource)) capabilities.push("debug_description");
  if (/\.snp\.|makeConstraints|NSLayoutConstraint|translatesAutoresizingMask/.test(extSource)) capabilities.push("layout");
  if (/style|theme|color|font|appearance|backgroundColor/.test(extSource)) capabilities.push("styling");
  if (/@Published|@State|ObservableObject|Combine/.test(extSource)) capabilities.push("reactive");
  if (/preview|PreviewProvider|#Preview/.test(extSource)) capabilities.push("preview");

  if (capabilities.length === 0) {
    // Count functions added by extensions as a generic signal
    const funcCount = (extSource.match(/func\s+\w+/g) ?? []).length;
    if (funcCount > 0) return `${funcCount}_methods`;
    return null;
  }

  return capabilities.slice(0, 4).join(",");
}

function inferAppleFrameworkRole(name: string): string {
  const roles: Record<string, string> = {
    UIKit: "UI_framework", SwiftUI: "declarative_UI", Foundation: "core_runtime",
    CoreData: "persistence", Combine: "reactive_streams", MapKit: "maps",
    AVFoundation: "audio_video", Photos: "photo_library", StoreKit: "in_app_purchase",
    CloudKit: "cloud_sync", WidgetKit: "widgets", CoreLocation: "location",
    CoreGraphics: "2D_graphics", Metal: "GPU_graphics", SceneKit: "3D_graphics",
    Security: "crypto_keychain", CryptoKit: "cryptography", os: "logging_tracing",
    Dispatch: "concurrency", GameKit: "game_center", HealthKit: "health_data",
    CoreML: "machine_learning", NaturalLanguage: "NLP", Vision: "computer_vision",
    ARKit: "augmented_reality", RealityKit: "3D_AR", CoreBluetooth: "bluetooth",
    NetworkExtension: "VPN_proxy", UserNotifications: "push_notifications",
    WebKit: "web_content", SafariServices: "safari_integration",
  };
  return roles[name] ?? "apple_sdk";
}

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE I/O
// ═══════════════════════════════════════════════════════════════════════════════

function loadCache(cachePath: string): SemanticCache {
  try {
    if (fs.existsSync(cachePath)) {
      return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    }
  } catch { /* corrupt — start fresh */ }
  return { version: "2.0", entries: {} };
}

function saveCache(cachePath: string, cache: SemanticCache): void {
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(cache));
  } catch { /* non-critical */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 3: FILE-LEVEL & TARGET-LEVEL HIERARCHICAL SUMMARIES
//
// These are synthesized from the resolved node_context values of entries
// within each file or target. They provide "Full Project Map" metadata
// for the MCP Agent (Claude) to understand project structure at a glance.
// ═══════════════════════════════════════════════════════════════════════════════

/** Group entries by source file and summarize each file's responsibility. */
function buildFileSummaries(entries: FlatMapEntry[]): Record<string, string> {
  const byFile = new Map<string, FlatMapEntry[]>();
  for (const e of entries) {
    if (e.flavor === "target" || !e.location.absPath) continue;
    const file = e.location.absPath;
    const arr = byFile.get(file) ?? [];
    arr.push(e);
    byFile.set(file, arr);
  }

  const summaries: Record<string, string> = {};
  for (const [filePath, fileEntries] of byFile) {
    const fileName = filePath.split("/").pop() ?? filePath;

    // Collect type codes and intents from children's node_context
    const types = new Set<string>();
    const intents: string[] = [];
    for (const e of fileEntries) {
      const ctx = (e as any).node_context as string | undefined;
      if (!ctx) continue;

      // Extract t: or e: value
      for (const seg of ctx.split("|")) {
        if (seg.startsWith("t:") || seg.startsWith("e:")) types.add(seg);
        if (seg.startsWith("i:")) {
          const val = seg.slice(2);
          if (val && !intents.includes(val)) intents.push(val);
        }
      }
    }

    const parts: string[] = [`t:f`]; // f = file
    parts.push(`n:${fileName}`);
    if (intents.length > 0) parts.push(`i:${intents.slice(0, 4).join(",")}`);
    if (types.size > 0) parts.push(`contains:${[...types].slice(0, 6).join(",")}`);
    parts.push(`count:${fileEntries.length}`);

    summaries[filePath] = parts.join("|");
  }

  return summaries;
}

/** Summarize each target's scope from its contained objects and functions. */
function buildTargetSummaries(
  entries: FlatMapEntry[],
  childrenOf: Map<string, string[]>,
): Record<string, string> {
  const summaries: Record<string, string> = {};

  for (const e of entries) {
    if (e.flavor !== "target") continue;

    // Gather all entries that belong to this target (id prefix match)
    const targetPrefix = `${e.id}::`;
    const contained = entries.filter(
      (c) => c.id.startsWith(targetPrefix) && c.flavor !== "target"
    );

    const objectCount = contained.filter((c) => OBJECT_FLAVORS.has(c.flavor)).length;
    const funcCount = contained.filter((c) => c.flavor === "function" || c.flavor === "variable").length;

    // Collect intents from contained node_contexts
    const intents: string[] = [];
    for (const c of contained) {
      const ctx = (c as any).node_context as string | undefined;
      if (!ctx) continue;
      for (const seg of ctx.split("|")) {
        if (seg.startsWith("i:")) {
          const val = seg.slice(2);
          if (val && !intents.includes(val)) intents.push(val);
        }
      }
    }

    // Merge with existing node_context if present
    const existing = (e as any).node_context as string | undefined;
    const parts: string[] = existing ? [existing] : [`t:tg|i:${e.origin ? (e.origin === "Apple" ? "apple_sdk" : "third_party") : "internal"}`];
    if (objectCount > 0) parts.push(`types:${objectCount}`);
    if (funcCount > 0) parts.push(`funcs:${funcCount}`);
    if (intents.length > 0 && !existing) parts.push(`scope:${intents.slice(0, 4).join(",")}`);

    summaries[e.id] = parts.join("|");
  }

  return summaries;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PERSISTENCE
// ═══════════════════════════════════════════════════════════════════════════════

export function persistEnrichedGraph(
  entries: FlatMapEntry[],
  workspacePath: string
): string | null {
  const stealthDir = path.join(workspacePath, ".swiftprism");
  const graphPath = path.join(stealthDir, "prism-context.json");

  try {
    if (!fs.existsSync(stealthDir)) fs.mkdirSync(stealthDir, { recursive: true });
    const gitignorePath = path.join(stealthDir, ".gitignore");
    if (!fs.existsSync(gitignorePath)) fs.writeFileSync(gitignorePath, "*\n");

    fs.writeFileSync(graphPath, JSON.stringify(entries));
    return graphPath;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN: TWO-PASS ENRICHMENT
//
// Pass 1 (leaf nodes): Functions, macros, entry_points — no children.
//         Also handles target/library nodes (metadata-only, no source).
// Pass 2 (parent nodes): Classes, structs, enums, actors, protocols —
//         their context incorporates children's resolved contexts.
//
// Both passes are fully async with concurrency control.
// ═══════════════════════════════════════════════════════════════════════════════

export async function enrichWithSemanticContext(
  entries: FlatMapEntry[],
  stealthDir: string,
  callbacks?: EnrichCallbacks,
  cancellation?: { cancelled: boolean }
): Promise<EnrichResult> {
  clearFileCache();

  const cachePath = path.join(stealthDir, "semantic-cache.json");
  const cache = loadCache(cachePath);

  // Build parent→children index for hierarchical context
  const entryById = new Map(entries.map((e, i) => [e.id, { entry: e, index: i }]));
  const childrenOf = new Map<string, string[]>();
  for (const e of entries) {
    for (const pid of e.parents) {
      if (entryById.has(pid)) {
        const arr = childrenOf.get(pid) ?? [];
        arr.push(e.id);
        childrenOf.set(pid, arr);
      }
    }
  }

  // Build reverse caller index for target nodes
  const callersOf = new Map<string, string[]>();
  for (const e of entries) {
    for (const callId of e.calls ?? []) {
      const arr = callersOf.get(callId) ?? [];
      arr.push(e.name);
      callersOf.set(callId, arr);
    }
  }

  // Partition into leaves (pass 1) and parents (pass 2)
  const leaves: { entry: FlatMapEntry; index: number }[] = [];
  const parents: { entry: FlatMapEntry; index: number }[] = [];

  for (const e of entries) {
    if (!ELIGIBLE_FLAVORS.has(e.flavor)) continue;
    const item = entryById.get(e.id)!;
    if (OBJECT_FLAVORS.has(e.flavor)) {
      parents.push(item);
    } else {
      leaves.push(item);
    }
  }

  const totalEligible = leaves.length + parents.length;
  const result: EnrichResult = { enrichedCount: 0, cachedCount: 0, failedCount: 0, llmUsed: false };
  const ollamaReady = await isOllamaAvailable();
  result.llmUsed = ollamaReady;

  const progress: ContextProgress = { total: totalEligible, completed: 0, cached: 0, llmUsed: ollamaReady };
  callbacks?.onProgress?.(progress);

  // ── Pass 1: Leaf nodes + targets ──
  await processBatch(leaves, entries, cache, ollamaReady, result, progress, callbacks, cancellation, childrenOf, callersOf);

  // ── Pass 2: Parent nodes (can now read children's contexts) ──
  if (!cancellation?.cancelled) {
    await processBatch(parents, entries, cache, ollamaReady, result, progress, callbacks, cancellation, childrenOf, callersOf);
  }

  // ── Pass 3: File-level and target-level hierarchical summaries ──
  // Synthesize contexts for files (by grouping entries by source path) and
  // for target nodes (by grouping their contained objects/functions).
  if (!cancellation?.cancelled) {
    const fileSummaries = buildFileSummaries(entries);
    const targetSummaries = buildTargetSummaries(entries, childrenOf);

    // Persist these as a separate metadata file for MCP consumption
    try {
      const metaPath = path.join(stealthDir, "_meta_summaries.json");
      const dir = path.dirname(metaPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(metaPath, JSON.stringify({ files: fileSummaries, targets: targetSummaries }));
    } catch { /* non-critical */ }
  }

  saveCache(cachePath, cache);
  clearFileCache();

  return result;
}

async function processBatch(
  items: { entry: FlatMapEntry; index: number }[],
  entries: FlatMapEntry[],
  cache: SemanticCache,
  ollamaReady: boolean,
  result: EnrichResult,
  progress: ContextProgress,
  callbacks: EnrichCallbacks | undefined,
  cancellation: { cancelled: boolean } | undefined,
  childrenOf: Map<string, string[]>,
  callersOf: Map<string, string[]>,
): Promise<void> {
  const queue = [...items];
  const inFlight: Promise<void>[] = [];

  while (queue.length > 0 || inFlight.length > 0) {
    if (cancellation?.cancelled) break;

    while (inFlight.length < MAX_CONCURRENT && queue.length > 0) {
      const item = queue.shift()!;
      const task = processNode(
        item.entry, item.index, entries, cache, ollamaReady,
        result, progress, callbacks, childrenOf, callersOf
      );
      const tracked = task.then(() => {
        const idx = inFlight.indexOf(tracked);
        if (idx >= 0) inFlight.splice(idx, 1);
      });
      inFlight.push(tracked);
    }

    if (inFlight.length > 0) await Promise.race(inFlight);
  }
}

async function processNode(
  entry: FlatMapEntry,
  index: number,
  entries: FlatMapEntry[],
  cache: SemanticCache,
  ollamaReady: boolean,
  result: EnrichResult,
  progress: ContextProgress,
  callbacks: EnrichCallbacks | undefined,
  childrenOf: Map<string, string[]>,
  callersOf: Map<string, string[]>,
): Promise<void> {
  const isTarget = entry.flavor === "target";
  const isParent = OBJECT_FLAVORS.has(entry.flavor);

  // For parent nodes, gather children's resolved contexts
  const childContexts: string[] = [];
  if (isParent) {
    for (const childId of childrenOf.get(entry.id) ?? []) {
      const childEntry = entries.find((e) => e.id === childId);
      if (childEntry && (childEntry as any).node_context) {
        childContexts.push((childEntry as any).node_context);
      }
    }
  }

  // Callers for target nodes
  const callerNames = isTarget ? (callersOf.get(entry.id) ?? []) : [];

  // Source extraction: for objects, merge primary definition + all extension blocks
  let sourceCode: string | null = null;
  let extensionCount = 0;
  if (!isTarget) {
    if (isParent) {
      const merged = extractMergedObjectSource(entry);
      sourceCode = merged.merged;
      extensionCount = merged.extensionCount;
    } else {
      sourceCode = extractSource(entry.location.absPath, entry.location.line);
    }
  }

  // Build content for hash (includes extensions, children, and lifecycle arrays)
  let hashInput: string;
  if (isTarget) {
    hashInput = `${entry.id}:${entry.origin ?? ""}:${callerNames.slice(0, 5).join(",")}`;
  } else {
    hashInput = sourceCode ?? `${entry.id}:${entry.flavor}:${entry.name}`;
    if (extensionCount > 0) hashInput += `|ext:${extensionCount}`;
    if (childContexts.length > 0) hashInput += `|children:${childContexts.length}`;
    if (entry.inits?.length) hashInput += `|inits:${entry.inits.join(",")}`;
    if (entry.deinits?.length) hashInput += `|deinits:${entry.deinits.join(",")}`;
  }
  const hash = hashContent(hashInput);

  // Cache check
  const cached = cache.entries[entry.id];
  if (cached && cached.hash === hash) {
    (entries[index] as any).node_context = cached.context;
    result.cachedCount++;
    progress.cached++;
    progress.completed++;
    callbacks?.onNodeEnriched?.(entry.id, cached.context);
    callbacks?.onProgress?.({ ...progress });
    return;
  }

  // Try LLM — source code + calls index map for [n] referencing
  let context: string | null = null;
  if (ollamaReady) {
    if (isTarget) {
      context = await queryOllama(USP_SYSTEM_PROMPT, buildLibraryPrompt(entry, callerNames));
    } else if (sourceCode) {
      let prompt = sourceCode;
      // Append tagged index maps: c[n], i[n], di[n]
      const maps: string[] = [];
      if (entry.calls?.length)
        maps.push(`c: [${entry.calls.map((id, n) => `c[${n}]=${id.split("::").pop() ?? id}`).join(", ")}]`);
      if (entry.inits?.length)
        maps.push(`i: [${entry.inits.map((id, n) => `i[${n}]=${id.split("::").pop() ?? id}`).join(", ")}]`);
      if (entry.deinits?.length)
        maps.push(`di: [${entry.deinits.map((id, n) => `di[${n}]=${id.split("::").pop() ?? id}`).join(", ")}]`);
      if (entry.implements?.length)
        maps.push(`imp: [${entry.implements.map((id, n) => `imp[${n}]=${id.split("::").pop() ?? id}`).join(", ")}]`);
      if (maps.length > 0) prompt += `\n\n// ${maps.join("\n// ")}`;
      if (isParent && childContexts.length > 0) {
        prompt += `\n// Members:\n// ${childContexts.slice(0, 6).join("\n// ")}`;
      }
      context = await queryOllama(USP_SYSTEM_PROMPT, prompt);
    }
  }

  // Fallback — pass extensionCount so it can emit ext: token
  if (!context) {
    context = generateFallback(entry, sourceCode, childContexts, callerNames, extensionCount);
  }

  (entries[index] as any).node_context = context;
  result.enrichedCount++;

  cache.entries[entry.id] = { hash, context, generatedAt: new Date().toISOString() };
  callbacks?.onNodeEnriched?.(entry.id, context);

  progress.completed++;
  callbacks?.onProgress?.({ ...progress });
}
