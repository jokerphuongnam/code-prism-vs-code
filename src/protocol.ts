export type SymbolFlavor =
  | "struct"
  | "class"
  | "enum"
  | "actor"
  | "protocol"
  | "function"
  | "variable"
  | "initializer"
  | "macro"
  | "entry_point"
  | "target";

export type SymbolSubKind =
  | "willSet"
  | "didSet"
  | "getter"
  | "setter"
  | "computed"
  | "stored";

export type AccessLevel =
  | "open"
  | "public"
  | "internal"
  | "fileprivate"
  | "private"
  | "package";

export type LinkType =
  | "call"
  | "access"
  | "conformance"
  | "inheritance"
  | "observer_trigger"
  | "resource_link"
  | "resource_alias"
  | "heuristic_link"
  | "cross_target_dependency"
  | "macro_expansion"
  | "extension_contribution"
  | "nesting"
  | "environment_injection"
  | "environment_provider"
  | "holds_type"
  | "enum_usage"
  | "import_dependency";

export type LinkConfidence = "high" | "medium" | "low";

export type ResourceType =
  | "image_set"
  | "color_set"
  | "data_set"
  | "asset_catalog"
  | "json_file"
  | "plist_file"
  | "markdown_file"
  | "strings_file"
  | "localization"
  | "other_file";

export type TargetType =
  | "executable"
  | "library"
  | "test"
  | "macro"
  | "plugin"
  | "unknown";

// TODO: Potential Redundant — MacroType not currently referenced
export type MacroType = "attached" | "freestanding";

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface PrismNode {
  id: string;
  name: string;
  flavor: SymbolFlavor;
  subKind: SymbolSubKind | null;
  isStatic: boolean;
  isGlobal: boolean;
  isNested: boolean;
  isInteresting: boolean;
  access: AccessLevel;
  parent: string | null;
  parentFile: string | null;
  sourceFile: string;
  location: SourceLocation;
  targetName: string | null;
  memberCount: number | null;
  /** Argument label signature for overload disambiguation, e.g. "(id:)" or "(data:metadata:)".
   *  Emitted by the Swift binary for functions and initializers. */
  signature?: string | null;
  isProtocolRequirement?: boolean;
}

export interface ResourceNode {
  id: string;
  name: string;
  resourceType: ResourceType;
  catalogName: string | null;
  parentGroup: string | null;
  filePath: string;
}

export interface TargetInfo {
  name: string;
  type: TargetType;
  path: string;
  dependencies: string[];
}

// TODO: Potential Redundant — MacroNode not currently referenced
export interface MacroNode {
  id: string;
  name: string;
  macroType: MacroType;
  role: string | null;
  conformances: string[];
  generatedSymbols: string[];
  location: SourceLocation;
  targetName: string | null;
}

export interface CallSiteRef {
  line: number;
  column: number;
  snippet: string;
  file: string;
}

export interface PrismLink {
  source_id: string;
  target_id: string;
  type: LinkType;
  confidence: LinkConfidence | null;
  references: CallSiteRef[] | null;
  /** Argument labels at the call site, e.g. "(id:)" — used to resolve the correct overload */
  targetSignature?: string | null;
}

// TODO: Potential Redundant — ModuleNode not currently referenced
export interface ModuleNode {
  id: string;
  name: string;
  moduleType: TargetType;
  isMacro: boolean;
  symbolCount: number;
  publicSymbolCount: number;
}

export interface AnalysisResult {
  projectRoot: string | null;
  nodes: PrismNode[];
  links: PrismLink[];
  resources: ResourceNode[];
  targets: TargetInfo[];
  macros: MacroNode[];
  moduleNodes: ModuleNode[] | null;
}

export type AnalysisPhase =
  | "idle"
  | "scanning"
  | "targets"
  | "resources"
  | "macros"
  | "resolving"
  | "encoding"
  | "streaming"
  | "semantic_context"
  | "complete"
  | "error";

export interface ProgressInfo {
  phase: AnalysisPhase;
  processed: number;
  total: number;
}

// ─── Flat Graph Schema (v4.0) ───

export interface SourcePosition {
  line: number;
  col: number;
  absPath: string;
}

// TODO: Potential Redundant — ObjectLocation not currently referenced
export interface ObjectLocation extends SourcePosition {
  type: "primary" | "extension";
}

// TODO: Potential Redundant — ExecutionBlockKind not currently referenced
export type ExecutionBlockKind =
  | "func"
  | "init"
  | "deinit"
  | "get"
  | "set"
  | "willSet"
  | "didSet"
  | "var_body";

export interface CallRef {
  target: string;
  location: SourcePosition;
}

/**
 * A single node in the flat graph. Every object, member, init, deinit,
 * and global function is a top-level entry. NO nesting.
 *
 * Hierarchy is expressed purely through `parents`:
 *   - Member parents: ["Target::ClassName"]
 *   - Object parents: ["FileName.swift"] or ["Target::ParentObject"]
 *   - File parents: (not emitted — files are implicit)
 *
 * To find all members of a class: filter for nodes where parents includes that class ID.
 */
export interface FlatGraphNode {
  id: string;
  name: string;
  flavor: SymbolFlavor;
  /** Single location for members (func, init, willSet, etc.) — points to the exact block start */
  location: SourcePosition;
  parents: string[];
  calls: CallRef[];

  /** Object-only: extension block locations for "Defined In" navigation */
  locations?: SourcePosition[];
  /** Object-only: superclass ID (null if none) */
  extends?: string | null;
  /** Object-only: protocol conformance IDs */
  implements?: string[];
  /** Object-only: stored property type dependencies (non-native custom types/targets) */
  stores?: string[];
  /** Object-only: fast-track init IDs (strings, not full objects) */
  inits?: string[];
  /** Object-only: fast-track deinit IDs (strings, not full objects) */
  deinits?: string[];
  isProtocolRequirement?: boolean;
  returnTypes?: string[];
  parameterTypes?: string[];
  /** Target-only: origin path/URL (e.g. "Apple SDK", Git URL, or absolute path) */
  origin?: string;
}

export interface EntryPointNode {
  id: string;
  kind: "@main" | "main.swift" | "AppDelegate";
  location: SourcePosition;
  parents: string[];
  calls: CallRef[];
}

export interface TargetGroup {
  name: string;
  type: TargetType;
  path: string;
  dependencies: string[];
  isExternal: boolean;
  entryPoint: EntryPointNode | null;
  resources: ResourceNode[];
}

export interface FlatGraphResult {
  schemaVersion: string;
  projectRoot: string;
  targets: TargetGroup[];
  nodes: FlatGraphNode[];
}
