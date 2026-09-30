/** Browser-safe (`@ai-switchboard/sdk/schema`): no Node imports belong here. */
export {
  createAjv,
  compileSchema,
  validateAgainst,
  isValidSchema,
  formatErrors,
  parseWith,
  tryParse,
  SchemaMismatchError,
} from './ajv.js';
export type { CreateAjvOptions, SchemaCheck, ParseWithOptions } from './ajv.js';

export { schemaFields, secretPaths } from './fields.js';
export type { SchemaField } from './fields.js';

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

export {
  ATTRIBUTE_KINDS,
  ATTRIBUTE_NAME_PATTERN,
  customEventTypePattern,
  eventTypeDefinitionSchema,
  openAttributesSchema,
} from '../custom-events.js';
export type { AttributeKind, AttributeDefinition, EventTypeDefinition } from '../custom-events.js';

export { attr, flatAttributesSchema } from './attributes.js';
