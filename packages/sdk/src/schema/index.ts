/** Browser-safe (`@ai-switchboard/sdk/schema`): no Node imports belong here. */
export {
  createAjv,
  compileSchema,
  validateAgainst,
  isValidSchema,
  formatErrors,
  secretPaths,
  parseWith,
  tryParse,
  SchemaMismatchError,
} from './ajv.js';
export type { CreateAjvOptions, SchemaCheck, ParseWithOptions } from './ajv.js';

export {
  UI_KEYWORDS,
  X_WIDGETS,
  isXWidget,
  xSecret,
  xWidget,
  xGroup,
  xOrder,
  xPlaceholder,
  xHelp,
  xWarnings,
  xEnumLabels,
  xEffectiveDefaults,
  xDocs,
} from './extensions.js';
export type {
  UiKeyword,
  XWidget,
  XWarning,
  XEffectiveDefault,
  XDocs,
  SchemaUiExtensions,
} from './extensions.js';

export {
  SECRET_SCHEME,
  SECRET_PROVIDER_SEGMENT,
  isSecretProviderSegment,
  isSecretRef,
  parseSecretRef,
  formatSecretRef,
} from './secret-refs.js';
export type { SecretRef } from './secret-refs.js';
