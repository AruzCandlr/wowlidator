/** Public surface of the wowlidator framework. */

export {
  CacheManager,
  CACHE_FILE_VERSION,
  DEFAULT_CACHE_FILENAME,
  scopeUrl,
  type CacheManagerOptions,
  type HealedSelectorCacheFile,
  type HealedSelectorEntry,
} from './cache/cache-manager.js';

export {
  LlmHealerModel,
  captureAxNodes,
  captureAxTree,
  DEFAULT_MAX_AX_NODES,
  DEFAULT_MIN_CONFIDENCE,
  HEAL_STRATEGIES,
  HealFailedError,
  HealUnavailableError,
  JitHealer,
  type HealInput,
  type HealOutcome,
  type HealRequest,
  type HealStrategy,
  type HealSuggestion,
  type AxNode,
  type HealerModel,
  type JitHealerOptions,
} from './healer/jit-healer.js';

export {
  DEFAULT_BASELINE_DIR,
  DEFAULT_DIFF_RATIO,
  DEFAULT_PIXEL_THRESHOLD,
  baselinePath,
  compareSnapshot,
  isVisualFailure,
  type CompareOptions,
  type SnapshotOutcome,
  type SnapshotResult,
} from './visual/baseline.js';

export {
  DEFAULT_HISTORY_PATH,
  DEFAULT_HISTORY_WINDOW,
  RunHistory,
  analyseTrend,
  failureSignatures,
  formatTrend,
  toHistoryEntry,
  type HistoryEntry,
  type RunTrend,
  type TrendVerdict,
} from './history/run-history.js';

export {
  canonicalSelector,
  formatCoverage,
  interactiveControls,
  measureCoverage,
  parseRoleSelector,
  type CoverageReport,
  type CoveredControl,
} from './coverage/ax-coverage.js';

export {
  ASSERTION_ACTIONS,
  hasAssertion,
  type AssertionAction,
  type DataCase,
} from './engine/runner.js';

export {
  DEFAULT_CDP_URL,
  DEFAULT_FAST_TIMEOUT_MS,
  DEFAULT_HEALED_TIMEOUT_MS,
  BrowserGoneError,
  SessionLostError,
  SmartRunner,
  StepResolutionError,
  isBrowserGone,
  executeFlow,
  runFlow,
  type Flow,
  type FlowStep,
  type RunFlowOptions,
  type ScreenshotMode,
  type SmartRunnerOptions,
} from './engine/runner.js';

export {
  API_STEP_ACTIONS,
  ProofBundleBuilder,
  formatAgentAction,
  formatProofSummary,
  formatStepLine,
  writeProofBundle,
  type AgentAction,
  type AgentRecord,
  type Defect,
  type DefectCategory,
  type DefectSeverity,
  type DialogRecord,
  type GenerationProvenance,
  type HealRecord,
  type ProofBundle,
  type DataCaseResult,
  type DataRetryAttempt,
  type DataRetryRecord,
  type ProofStep,
  type ProofSummary,
  type RejectedHeal,
  type TierSummary,
  type ResolutionSource,
  type RunStatus,
  type StepStatus,
} from './engine/proof-bundle.js';

export {
  describeDialog,
  findDismissButton,
  openDialogNow,
  waitForDialog,
  type DismissButton,
} from './engine/modal.js';

export { isRoleSelector, relaxRoleName, withRelaxedRoleName } from './engine/selector.js';

export {
  DEFAULT_MAX_INCLUDE_DEPTH,
  FlowCompositionError,
  expandFlow,
  hasIncludes,
  type ExpandOptions,
} from './engine/compose.js';

export {
  DEFAULT_MAX_PROBES,
  DEFAULT_PROBE_SETTLE_MS,
  formatProbeReport,
  probeInteractions,
  type ProbeOptions,
  type ProbeReport,
  type ProbeResult,
} from './context/page-probe.js';

export {
  AUTHOR_ACTIONS,
  AuthoringError,
  DEFAULT_AUTHOR_MAX_NODES,
  FlowAuthor,
  LlmFlowAuthorModel,
  type AuthorAction,
  type AuthorRequest,
  type AuthorResult,
  type AuthoredFlow,
  type FlowAuthorModel,
  type FlowAuthorOptions,
  type LlmFlowAuthorModelOptions,
} from './generator/flow-author.js';

/**
 * Catalogs: a document of claims becomes a test, with a gate in the middle.
 * `extractDocument` is useful on its own — it is the only part of this that
 * reads .xlsx and .pdf, and it makes no model call.
 */
export {
  DEFAULT_MAX_CHARS,
  MAX_FILE_BYTES,
  SUPPORTED_EXTENSIONS,
  EmptyDocumentError,
  UnsupportedDocumentError,
  extractDocument,
  extractDocumentFile,
  formatFor,
  htmlToText,
  type DocumentFormat,
  type ExtractedDocument,
} from './catalog/extract.js';

export {
  CONTEXT_BUDGET_CHARS,
  CONTEXT_DOC_MAX_CHARS,
  CONTEXT_RETRIEVAL_MIN_CHARS,
  chunkDocument,
  rankChunks,
  selectRelevantContext,
  tokenize,
  type ContextChunk,
  type ContextSelection,
  type ScoredChunk,
} from './catalog/retrieve.js';

export {
  CatalogError,
  DEFAULT_MAX_CLAIMS,
  LlmCatalogModel,
  approvedClaims,
  buildAuthoringPrompt,
  buildClaimsPrompt,
  extractClaims,
  parseClaimsFile,
  toClaimsFile,
  type ApprovedClaim,
  type CatalogClaim,
  type CatalogClaims,
  type CatalogModel,
  type ClaimsFile,
  type ClaimsRequest,
} from './catalog/catalog.js';

export {
  LlmGeneratorModel,
  DEFAULT_GENERATOR_MAX_NODES,
  TEST_KINDS,
  TestGenerator,
  type GenerateRequest,
  type GeneratedCase,
  type GeneratedSuite,
  type GenerationResult,
  type GeneratorModel,
  type MutationPolicy,
  type RejectedCase,
  type TestGeneratorOptions,
  type TestKind,
} from './generator/test-generator.js';

export {
  AGENT_ACTIONS,
  LlmAgentModel,
  DEFAULT_AGENT_MAX_STEPS,
  WorkflowAgent,
  type AgentActionKind,
  type AgentDecision,
  type AgentModel,
  type AgentObservation,
  type WorkflowAgentOptions,
  type WorkflowResult,
} from './orchestrator/workflow-agent.js';

export {
  GRIM_BASE,
  GRIM_COMPONENTS,
  GRIM_PALETTE,
  GRIM_TOKENS,
  grimTheme,
  toneOf,
  type GrimTone,
} from './reporter/theme.js';

export {
  GLOSSARY,
  DEFAULT_REPORT_DIR,
  DEFAULT_REPORT_FILENAME,
  REPORT_PLACEHOLDERS,
  defaultReportFilename,
  reportGroupForUrl,
  renderReport,
  resolveReportPath,
  slugify,
  writeHtmlReport,
  writeReport,
  type RenderOptions,
  type ReportNameContext,
  type ReportPlaceholder,
  type ReportTarget,
} from './reporter/html-reporter.js';

export {
  CHROME_CANDIDATES,
  DEFAULT_BOOT_TIMEOUT_MS,
  DEFAULT_CHROME_PROFILE,
  cdpAnswers,
  cdpDrivable,
  chromeIsOurs,
  chromeMatchPattern,
  ensureChrome,
  ensureTab,
  findChrome,
  portOf,
  startChrome,
  stopChrome,
  waitForApp,
  type EnsureOptions,
  type EnsureResult,
  type EnsureStatus,
} from './browser/chrome.js';

export {
  DEFAULT_MAX_HEAL_ATTEMPTS,
  DEFAULT_MAX_PAGES,
  DEFAULT_TIMEOUT_MS as DEFAULT_CRAWL_TIMEOUT_MS,
  crawlFrom,
  discoverLinks,
  formatCrawlReport,
  looksLikeAction,
  settle,
  type CrawlOptions,
  type CrawlReport,
  type DiscoveredLink,
  type HealAttempt,
  type SkippedLink,
  type VisitResult,
} from './crawl/crawler.js';

export {
  CONSECUTIVE_PASSES_TO_CLEAR,
  decideQuarantine,
  type QuarantineDecision,
} from './history/quarantine.js';

export {
  DEFAULT_INTERVAL_MS,
  MIN_INTERVAL_MS,
  classifyChange,
  formatWatchLine,
  notifyPayload,
  parseInterval,
  runNotify,
  type ChangeKind,
  type NotifyPayload,
  type WatchState,
} from './watch.js';

export {
  renderCtrf,
  renderJUnit,
  writeCtrfReport,
  writeJUnitReport,
  type CtrfReport,
  type MachineReportOptions,
} from './reporter/machine-report.js';

export {
  DEFAULT_INDEX_FILENAME,
  rankEntries,
  renderSuiteIndex,
  writeSuiteIndex,
  type IndexEntry,
  type SuiteIndexOptions,
} from './reporter/suite-index.js';

export {
  VERDICT_COPY,
  buildVerdict,
  describeStep,
  escalationTrace,
  ownerOf,
  type Owner,
  type TraceRung,
  type Verdict,
} from './reporter/verdict.js';

export {
  ConfigError,
  DEFAULT_MAX_RETRIES,
  DEFAULT_ROLE_MODELS,
  LLM_ROLES,
  PROVIDERS,
  PROVIDER_META,
  describeRouting,
  hasKeyForRole,
  loadConfig,
  type LlmRole,
  type ProviderName,
  type RoleConfig,
  type WowlidatorConfig,
} from './config.js';

export {
  AllKeysExhaustedError,
  LlmFactory,
  MissingApiKeyError,
  createModelForRole,
  generateStructured,
  generateStructuredForModel,
  isKeyExhaustedError,
  modelIdFor,
  type ModelSource,
  type ResolvedModel,
  type StructuredRequest,
  type StructuredResponse,
} from './providers/llm-factory.js';

export {
  ContextEngine,
  DEFAULT_CONTEXT_CACHE_FILE,
  matchesRoutePattern,
  pathnameOf,
  type ContextEngineOptions,
} from './context/context-engine.js';

export {
  DEFAULT_CONTEXT_MAX_NODES,
  findRouteForUrl,
  summarize as summarizeContext,
  toPromptContext,
  type PromptContextOptions,
} from './context/query.js';

export type {
  Ingester,
  IngestContext,
  IngestResult,
  ProjectEdge,
  ProjectEdgeKind,
  ProjectGraph,
  ProjectGraphSource,
  ProjectNode,
  ProjectNodeKind,
} from './context/types.js';

export {
  DATA_KINDS,
  generateValue,
  isDeterministicKind,
  type DataKind,
} from './data/mock-data.js';

export {
  LlmDataModel,
  type DataGenerateRequest,
  type DataGenerateResult,
  type DataModel,
  type LlmDataModelOptions,
} from './data/data-model.js';

export {
  LlmFlowRepairModel,
  type FlowRepairModel,
  type LlmFlowRepairModelOptions,
  type RepairProposal,
  type RepairRequest,
} from './repair/flow-repair-model.js';

export {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_REPAIR_MAX_AX_NODES,
  FlowRepairLoop,
  type FlowRepairLoopOptions,
  type FlowRepairOutcome,
  type RepairAttempt,
  type RepairFileRecord,
} from './repair/flow-repair-loop.js';

export {
  DEFAULT_MAX_CALLS,
  NetworkObserver,
  classifyCall,
  describeCall,
  isBlockingFailure,
  type CallOutcome,
  type NetworkCall,
  type NetworkObserverOptions,
} from './api/network-observer.js';

export {
  DEFAULT_REDACTION,
  REDACTED,
  SENSITIVE_HEADERS,
  redactBody,
  redactHeaders,
  redactUrl,
  type RedactionPolicy,
} from './api/redact.js';

export {
  BrowserTransport,
  DEFAULT_REQUEST_TIMEOUT_MS,
  FetchTransport,
  parseJson,
  recordOf,
  type ApiRequestSpec,
  type ApiResponse,
  type ApiTransport,
  type RequestRecord,
} from './api/api-client.js';

export {
  ApiActions,
  MethodRefusedError,
  NoResponseError,
  methodRefused,
  type ApiActionsOptions,
  type FlowRequestSpec,
} from './api/api-actions.js';

export {
  ObservationTruncatedError,
  ObservationUnavailableError,
  callSatisfies,
  describeExpected,
  matchExpectedCalls,
  neverViolations,
  parseExpectedCallEntry,
  type CallMatch,
  type ExpectedCall,
  type FlowExpectCallsSpec,
  type SequenceMatchResult,
  type StatusClass,
} from './api/expect-calls.js';

export {
  DbGroundingError,
  DbUnavailableError,
  connectDb,
  defaultDbConfig,
  isLoopbackDsn,
  maskDsn,
  type DbClient,
  type DbColumn,
  type DbConfig,
  type DbResult,
  type DbSchema,
  type DbTable,
} from './db/client.js';

export {
  DEFAULT_DB_TIMEOUT_MS,
  DbActions,
  looseEquals,
  parseDbConditions,
  quoteIdent,
  type DbActionsOptions,
  type DbCheckRecord,
  type FlowDbCalledSpec,
  type FlowDbDeltaSpec,
  type FlowDbRowSpec,
  type FlowDbSnapshotSpec,
  type FlowDbUnchangedSpec,
  type FlowDbValue,
} from './db/db-actions.js';

export {
  DB_EVIDENCE_MAX_ROWS,
  redactRow,
  redactRows,
  redactValue,
  redactWhereSummary,
} from './db/redact-row.js';

export {
  SequenceParseError,
  classifyPlanes,
  isObservable,
  looksLikeSequenceDiagram,
  parseSequenceDiagram,
  sequenceToClaims,
  type ParticipantPlane,
  type SequenceDoc,
  type SequenceMessage,
  type SequenceParticipant,
} from './catalog/sequence.js';

export {
  UnknownVariableError,
  VariableStore,
  extractPath,
  stringifyExtracted,
} from './api/variables.js';

export {
  OpenApiIngester,
  toRoutePattern,
  type OpenApiIngesterOptions,
} from './context/ingesters/openapi-ingester.js';

export {
  SchemaIngester,
  parsePrismaSchema,
  parseSqlSchema,
  type SchemaIngesterOptions,
} from './context/ingesters/schema-ingester.js';

export { matchesCall } from './context/route-match.js';

export {
  API_GENERATOR_ACTIONS,
  ApiTestGenerator,
  DEFAULT_MAX_OPERATIONS,
  GeneratedApiStepSchema,
  LlmApiGeneratorModel,
  NoSpecError,
  toApiFlowStep,
  type ApiGenerateRequest,
  type ApiGenerationResult,
  type ApiGeneratorModel,
  type ApiTestGeneratorOptions,
  type LlmApiGeneratorModelOptions,
} from './generator/api-test-generator.js';
