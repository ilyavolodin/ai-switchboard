export type * from './types/common.js';
export type * from './types/events.js';
export type * from './types/source.js';
export type * from './types/destination.js';
export type * from './types/notifier.js';
export type * from './types/context.js';
export { dedupeKey } from './types/events.js';

export {
  definePlugin,
  isPluginDefinition,
  validatePlugin,
  MAX_INVOKE_TIMEOUT_SECONDS,
} from './plugin.js';
export type { PluginDefinition, PluginKind, PluginSpec } from './plugin.js';

export { createHttpClient, hostMatches, makeResponse, parseRetryAfter } from './http.js';
export type { HttpClient, HttpClientOptions, HttpRequest, HttpResponse } from './http.js';

export { signHmac, verifyHmac, safeEqual } from './hmac.js';
export type { HmacOptions } from './hmac.js';

export { noopLogger, createMemoryLogger } from './logger.js';
export type { Logger, LogFields, MemoryLogEntry } from './logger.js';

export {
  TransportError,
  CapabilityError,
  InvokeError,
  isTransportError,
  isInvokeError,
  invokeErrorForStatus,
} from './errors.js';

export * from './schema/index.js';

export {
  ATTRIBUTE_KINDS,
  ATTRIBUTE_NAME_PATTERN,
  customEventTypePattern,
  eventTypeDefinitionSchema,
  compileEventTypes,
  coerceAttribute,
  toIsoTime,
  narrowMapped,
  openAttributesSchema,
  flattenAttributes,
  attributeKey,
} from './custom-events.js';
export type {
  AttributeKind,
  AttributeDefinition,
  EventTypeDefinition,
  CompiledEventType,
  MappedEvent,
  FlattenOptions,
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
