import type { SOURCE_MODES } from '../constants.js';
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
  /** The external system's id for the created webhook. */
  externalId?: string;
  message?: string;
}

export interface ParseReport {
  events: EventDraft[];
  /** Why parts of the delivery produced no event, for the person previewing a sample. */
  notes: string[];
}

export interface PollResult {
  events: EventDraft[];
  watermark: string;
  /** Why parts of the response produced no event. Never a secret or the raw body. */
  notes?: string[];
}

export interface Source {
  /** Signature / shared-secret check. Runs before `parse`; never trust an unverified body. */
  verify?(req: RawRequest): VerifyResult;
  /** Must be pure and deterministic (no I/O, no clock). May be async because JSONata is. */
  parse?(req: RawRequest): EventDraft[] | Promise<EventDraft[]>;
  /**
   * `parse` plus notes on why parts of the delivery produced no event; the sample-delivery
   * preview calls it instead of `parse`. Must return the same events as `parse`, stay pure,
   * and never put a secret or the raw body in a note.
   */
  parseWithNotes?(req: RawRequest): ParseReport | Promise<ParseReport>;
  /** Register the webhook in the external system via its API. */
  provision?(webhookUrl: string): Promise<ProvisionResult>;
  /** Fetch events after `watermark`; must advance the watermark and never re-emit. */
  poll?(watermark: string | null): Promise<PollResult>;
  /** Live state for filters and mappings. Never cached. Returns `null` when the artifact is gone. */
  resolve?(ref: ArtifactRef): Promise<ArtifactSnapshot | null>;
  /** e.g. PR → its tracker issue. */
  linked?(ref: ArtifactRef): Promise<ArtifactRef[]>;
  act?(action: string, args: unknown): Promise<ActionResult>;
  health(): Promise<Health>;
}

export type SourceMode = (typeof SOURCE_MODES)[number];

export interface SourceType {
  /** Kebab-case, unique across all plugins. */
  id: string;
  displayName: string;
  description?: string;
  /** A built-in icon name (`ICON_NAMES`) or a `data:image/svg+xml;base64,…` URI of at most 8 KB. */
  icon?: string;
  mode: SourceMode;
  settingsSchema: JSONSchema;
  eventTypes: EventTypeSpec[];
  actions?: ActionSpec[];
  /**
   * The person defines event types per instance; `eventTypes` is then only a template and the
   * real ones come from `instanceEventTypes(settings)`.
   */
  dynamicEventTypes?: boolean;
  instanceEventTypes?(settings: Settings): EventTypeSpec[];
  /** True when instances may run without `verify` (only the generic webhook's evaluation mode). */
  allowsUnauthenticated?: boolean;
  create(settings: Settings, ctx: PluginContext): Source;
}
