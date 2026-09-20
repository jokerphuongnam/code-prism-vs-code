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
  signature?: string | null;
  isProtocolRequirement?: boolean;
  /** Object-only: extension block locations for "Defined In" navigation */
  locations?: { file: string; line: number; column: number }[];
  /** Target-only: origin path/URL */
  origin?: string;
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
  targetSignature?: string | null;
}

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

export interface FlatMapEntry {
  id: string;
  name: string;
  flavor: string;
  location: { absPath: string; line: number; col: number };
  parents: string[];
  calls?: string[];
  /** Object-only: extension block locations for "Defined In" navigation */
  locations?: { absPath: string; line: number; col: number }[];
  inits?: string[];
  deinits?: string[];
  extends?: string | null;
  implements?: string[];
  stores?: string[];
  returns?: string[];
  parameters?: string[];
  origin?: string;
  /** Token-optimized semantic context from local LLM or fallback */
  node_context?: string;
}

export interface FilePreview {
  nodeId: string;
  previewType: "image" | "text" | "none";
  data: string;
  fileName: string;
}

export interface SemanticContextProgress {
  total: number;
  completed: number;
  cached: number;
  llmUsed: boolean;
}

export type HostToWebviewMessage =
  | { type: "analysisResult"; payload: AnalysisResult }
  | { type: "memberDetail"; parentId: string; payload: AnalysisResult }
  | { type: "mappingData"; payload: FlatMapEntry[] }
  | { type: "filePreview"; payload: FilePreview }
  | { type: "progress"; progress: ProgressInfo }
  | { type: "error"; message: string }
  | { type: "contextCopied"; tokenEstimate: number }
  | { type: "semanticContextProgress"; progress: SemanticContextProgress }
  | { type: "semanticContextComplete"; enrichedCount: number; cachedCount: number; llmUsed: boolean }
  | { type: "nodeContextUpdate"; nodeId: string; context: string }
  | { type: "pendingContextIds"; nodeIds: string[] };

export type WebviewToHostMessage =
  | { type: "analyzeRequest" }
  | { type: "copyContext"; nodeId: string }
  | { type: "openFile"; data: { file: string; line: number; col: number } }
  | { type: "requestRawJson" }
  | { type: "requestMembers"; nodeId: string }
  | { type: "requestFilePreview"; nodeId: string; filePath: string }
  | { type: "ready" };
