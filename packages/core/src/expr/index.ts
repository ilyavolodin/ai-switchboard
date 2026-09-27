export {
  createExpressionEngine,
  collectSecretRefs,
  isSecretRefMarker,
  replaceSecretRefs,
  resolveSecretRefs,
  secretRefString,
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
  SecretRefMarker,
} from './engine.js';
export {
  evaluateBatchKey,
  evaluateFilter,
  filterContext,
  mappingContext,
  renderTemplate,
  stepContext,
  toBoolean,
} from './contexts.js';
export type { FilterOutcome, KeyOutcome, RunContext } from './contexts.js';
export { evaluateMapping } from './mapping.js';
export type { MappingOutcome } from './mapping.js';
