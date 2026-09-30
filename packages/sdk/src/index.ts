export type * from './types/common.js';
export type * from './types/events.js';
export type * from './types/source.js';
export type * from './types/destination.js';
export type * from './types/notifier.js';
export type * from './types/context.js';
export { dedupeKey } from './dedupe.js';
export {
  HEALTH_STATUSES,
  INVOKE_STATUSES,
  PLUGIN_KINDS,
  RUN_STATES,
  SOURCE_MODES,
  TRACKING_MODES,
} from './constants.js';

import { isPluginDefinition as hostIsPluginDefinition } from './plugin.js';
import {
  createHttpClient as hostCreateHttpClient,
  hostMatches as hostHostMatches,
  makeResponse as hostMakeResponse,
  type HttpClientOptions as HostHttpClientOptions,
} from './http.js';
import * as schema from './schema/index.js';

export { definePlugin, validatePlugin, MAX_INVOKE_TIMEOUT_SECONDS } from './plugin.js';
export type { DeclaredCapabilities, PluginDefinition, PluginKind, PluginSpec } from './plugin.js';

/** @deprecated Import from `@ai-switchboard/sdk/host`. */
export const isPluginDefinition = hostIsPluginDefinition;
/** @deprecated Import from `@ai-switchboard/sdk/host`. */
export const createHttpClient = hostCreateHttpClient;
/** @deprecated Import from `@ai-switchboard/sdk/host`. */
export const hostMatches = hostHostMatches;
/** @deprecated Import from `@ai-switchboard/sdk/host`. */
export const makeResponse = hostMakeResponse;

export { parseRetryAfter } from './http.js';
/** @deprecated Import from `@ai-switchboard/sdk/host`. */
export type HttpClientOptions = HostHttpClientOptions;
export type { HttpClient, HttpRequest, HttpResponse } from './http.js';

export {
  isRecord,
  isOneOf,
  errorText,
  asObject,
  asString,
  asNumber,
  asBoolean,
  asArray,
  getPath,
  parseJsonObject,
  tryJson,
} from './json.js';
export type { JsonObject } from './json.js';

export { refusalFor, DEFAULT_RETRY_AFTER_SECONDS } from './refusal.js';
export type { RefusalOptions } from './refusal.js';

export { verifyHmacHeader, verifySharedSecretHeader } from './verify.js';
export type { HmacHeaderOptions } from './verify.js';

export {
  SWITCHBOARD_SIGNATURE_HEADER,
  SWITCHBOARD_SIGNATURE_PREFIX,
  SWITCHBOARD_RUN_ID_HEADER,
  signSwitchboardBody,
  verifySwitchboardSignature,
  readSignedJson,
  pickDeclaredUsage,
} from './protocol.js';

export { checkHealth } from './health.js';
export type { HealthProbe } from './health.js';

export { withSettings } from './settings.js';

export { signHmac, verifyHmac, safeEqual } from './hmac.js';
export type { HmacOptions } from './hmac.js';

export { noopLogger, createMemoryLogger } from './logger.js';
export type { Logger, LogFields, MemoryLogEntry } from './logger.js';

export {
  TransportError,
  CapabilityError,
  InvokeError,
  SecretNotFoundError,
  SecretStoreError,
  SECRET_KEY_PATTERN,
  isTransportError,
  isInvokeError,
  isCapabilityError,
  isSecretNotFoundError,
  isSecretStoreError,
  isWritableSecretProvider,
  invokeErrorForStatus,
} from './errors.js';

export {
  createAjv,
  compileSchema,
  validateAgainst,
  isValidSchema,
  formatErrors,
  parseWith,
  tryParse,
  SchemaMismatchError,
  schemaFields,
  UI_KEYWORDS,
  X_WIDGETS,
  SECRET_SCHEME,
  SECRET_PROVIDER_SEGMENT,
  isSecretProviderSegment,
  isSecretRef,
  parseSecretRef,
  formatSecretRef,
} from './schema/index.js';
export type {
  CreateAjvOptions,
  SchemaCheck,
  ParseWithOptions,
  SchemaField,
  UiKeyword,
  XWidget,
  XWarning,
  XEffectiveDefault,
  XDocs,
  SchemaUiExtensions,
  SecretRef,
} from './schema/index.js';

/** @deprecated Import from `@ai-switchboard/sdk/host`. */
export const secretPaths = schema.secretPaths;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const isXWidget = schema.isXWidget;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xSecret = schema.xSecret;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xWidget = schema.xWidget;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xGroup = schema.xGroup;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xOrder = schema.xOrder;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xPlaceholder = schema.xPlaceholder;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xHelp = schema.xHelp;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xWarnings = schema.xWarnings;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xEnumLabels = schema.xEnumLabels;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xEffectiveDefaults = schema.xEffectiveDefaults;
/** @deprecated The form reads these; import from `@ai-switchboard/sdk/schema`. */
export const xDocs = schema.xDocs;

export {
  compileEventTypes,
  coerceAttribute,
  toIsoTime,
  narrowMapped,
  describeMappedDrop,
  draftFromMapped,
  flattenAttributes,
  attributeKey,
  ATTRIBUTE_KINDS,
  ATTRIBUTE_NAME_PATTERN,
  customEventTypePattern,
  eventTypeDefinitionSchema,
  openAttributesSchema,
} from './custom-events.js';
export type {
  CompiledEventType,
  MappedEvent,
  DraftOptions,
  FlattenOptions,
  AttributeKind,
  AttributeDefinition,
  EventTypeDefinition,
} from './custom-events.js';

export {
  ICON_NAMES,
  ICON_DATA_URI_PREFIX,
  MAX_ICON_DATA_URI_LENGTH,
  isIconName,
  iconProblem,
} from './icons.js';
export type { IconName } from './icons.js';

export { SDK_VERSION, SDK_MAJOR } from './version.js';

export {
  verifySwitchboardCallback,
  callbackBodySchema,
  CALLBACK_BODY_PROPERTIES,
} from './protocol-callback.js';
export type { SwitchboardCallbackBody, CallbackOptions } from './protocol-callback.js';
export { parseDefinitive } from './definitive.js';
export { dispatchAction } from './actions.js';
export type { ActionHandlers } from './actions.js';
export {
  headerValue,
  responseSnippet,
  lowerCaseHeaders,
  RESPONSE_SNIPPET_CHARS,
} from './request.js';
export { meterReading } from './meters.js';
export type { MeterReadingInput } from './meters.js';
