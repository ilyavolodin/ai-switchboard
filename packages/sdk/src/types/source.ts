import type {
  ActionResult,
  ActionSpec,
  Health,
  JSONSchema,
  RawRequest,
  Settings,
  VerifyResult,
} from './common.js';
import type { ArtifactRef, ArtifactSnapshot, EventDraft, EventTypeSpec } from './events.js';
import type { PluginContext } from './context.js';

export interface ProvisionResult {
  ok: boolean;
  /** The external system's id for the created webhook, if any. */
  externalId?: string;
  message?: string;
}

export interface PollResult {
  events: EventDraft[];
  watermark: string;
}

/** A live source object, one per enabled source instance. */
export interface Source {
  // push
  /** Signature / shared-secret check. Runs before `parse`; never trust an unverified body. */
  verify?(req: RawRequest): VerifyResult;
  /**
   * One delivery → 0..n events. Must be pure and deterministic (no I/O, no clock). May be async
   * because JSONata evaluation is.
   */
  parse?(req: RawRequest): EventDraft[] | Promise<EventDraft[]>;
  /** Register the webhook in the external system via its API. */
  provision?(webhookUrl: string): Promise<ProvisionResult>;
  // pull
  /** Fetch events after `watermark`; must advance the watermark and never re-emit. */
  poll?(watermark: string | null): Promise<PollResult>;
  // shared
  /** Live state for filters and mappings. Never cached. Returns `null` when the artifact is gone. */
  resolve?(ref: ArtifactRef): Promise<ArtifactSnapshot | null>;
  /** e.g. PR → its tracker issue. */
  linked?(ref: ArtifactRef): Promise<ArtifactRef[]>;
  act?(action: string, args: unknown): Promise<ActionResult>;
  health(): Promise<Health>;
}

export interface SourceType {
  /** e.g. `'github'`; kebab-case, unique across all plugins. */
  id: string;
  displayName: string;
  description?: string;
  /**
   * Optional (since SDK 1.3): the icon the UI shows for this type. Either a built-in icon name
   * (`ICON_NAMES`) or a `data:image/svg+xml;base64,…` URI of at most 8 KB, rendered through
   * `<img>`. Without one the UI shows the kind's generic icon.
   */
  icon?: string;
  mode: 'push' | 'pull' | 'both';
  /** Per instance: credential refs, org, filters. */
  settingsSchema: JSONSchema;
  eventTypes: EventTypeSpec[];
  actions?: ActionSpec[];
  /**
   * When true, the person defines event types and attribute mapping per instance (the generic
   * `webhook` source). `eventTypes` then lists only a template, and the instance's own
   * definitions come from `instanceEventTypes(settings)`.
   */
  dynamicEventTypes?: boolean;
  instanceEventTypes?(settings: Settings): EventTypeSpec[];
  /** True when instances may run without `verify` (only the generic webhook's evaluation mode). */
  allowsUnauthenticated?: boolean;
  create(settings: Settings, ctx: PluginContext): Source;
}
