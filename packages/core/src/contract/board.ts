import type { AttentionAction, AttentionKind, StatusTone } from '../domain/status.js';
import type { Iso, StatusLabel } from './common.js';
import type { MeterGaugeDTO } from './destinations.js';

export interface AttentionItem {
  id: string;
  /** `process_disabled`: a disabled process that has never run turned events away in 24 h. */
  kind: AttentionKind;
  tone: StatusTone;
  title: string;
  detail: string;
  targetKind: 'process' | 'source' | 'destination' | 'plugin' | 'approval';
  targetId: string;
  /** The one-click action. */
  action: { id: AttentionAction; label: string };
  since: string | null;
}

export interface StatusStripResponse {
  meters: MeterGaugeDTO[];
  openBreakers: number;
  pendingApprovals: number;
  evaluation: boolean;
  oidcConfigured: boolean;
}

/** Five pipeline stops shown as dots: matched → batched → gated → invoked → ok. */
export interface PipelineDots {
  matched: number;
  batched: number;
  gated: number;
  invoked: number;
  ok: number;
  /** Tone per stop, derived from the last hour. */
  tones: [StatusTone, StatusTone, StatusTone, StatusTone, StatusTone];
}

export interface BoardSourceNode {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  typeIcon: string | null;
  status: StatusLabel;
  enabled: boolean;
  lastEventAt: Iso | null;
  events24h: number;
  pluginAvailable: boolean;
  unauthenticated: boolean;
}

export interface BoardProcessNode {
  id: string;
  name: string;
  status: StatusLabel;
  enabled: boolean;
  breakerOpen: boolean;
  awaitingApproval: number;
  dots: PipelineDots;
  nextSweepAt: Iso | null;
  runs24h: number;
  lastRunAt: Iso | null;
}

export interface BoardDestinationNode {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  typeIcon: string | null;
  status: StatusLabel;
  enabled: boolean;
  meters: MeterGaugeDTO[];
  softHoldUntil: Iso | null;
}

export interface BoardEdge {
  id: string;
  kind: 'trigger' | 'binding';
  from: string;
  to: string;
  /** Trigger edges: the event types. */
  eventTypes: string[];
  label: string;
  volume24h: number;
  /** Events (trigger) or runs (binding) in the last 5 minutes, for animated dots. */
  recent: number;
  enabled: boolean;
}

export interface BoardResponse {
  sources: BoardSourceNode[];
  processes: BoardProcessNode[];
  destinations: BoardDestinationNode[];
  edges: BoardEdge[];
  attention: AttentionItem[];
  generatedAt: Iso;
}
