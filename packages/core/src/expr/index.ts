export {
  createExpressionEngine,
  toPlain,
  DEFAULT_MAX_RESOLVE_CALLS,
  DEFAULT_TIMEOUT_MS,
  ENV_PREFIX,
} from './engine.js';
export type {
  EvalFunctions,
  EvalResult,
  ExprErrorCode,
  ExpressionEngine,
  ExpressionEngineOptions,
} from './engine.js';
export {
  approvalContext,
  evaluateBatchKey,
  evaluateFilter,
  filterContext,
  mappingContext,
  renderTemplate,
  stepContext,
  templateContext,
  toBoolean,
} from './contexts.js';
export type { FilterOutcome, KeyOutcome, RunContext } from './contexts.js';
export { evaluateMapping } from './mapping.js';
export type { MappingOutcome } from './mapping.js';
export {
  collectSecretMarkers,
  isSecretRefMarker,
  neutralizeSecretMarkers,
  replaceSecretMarkers,
  resolveSecretMarkers,
  secretRefString,
} from './secret-markers.js';
export type { SecretRefMarker } from './secret-markers.js';
export {
  ARTIFACT_FIELDS,
  BATCH_FIELDS,
  EVENT_FIELDS,
  EXPRESSION_CONTEXTS,
  EXPRESSION_CONTEXT_KINDS,
  PROCESS_FIELDS,
  RUN_CONTEXT_FIELDS,
  RUN_FIELDS,
  SWITCHBOARD_FUNCTIONS,
} from './context-descriptors.js';
export type {
  ContextField,
  ContextFieldType,
  ExpressionContextKind,
  SwitchboardFunction,
  SwitchboardFunctionName,
} from './context-descriptors.js';
