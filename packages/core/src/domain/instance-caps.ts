/** Core-added per-instance caps for sources (`sources.caps`). */
export interface SourceCaps {
  eventCapPerHour?: number;
  eventCapPerDay?: number;
  eventTypesEnabled?: string[];
  pollIntervalSeconds?: number;
  /** Only for `webhook` instances explicitly marked unauthenticated (evaluation). */
  unauthenticated?: boolean;
}

/** Core-added per-instance caps for destinations (`destinations.caps`). */
export interface DestinationCaps {
  runsPerHour?: number;
  runsPerDay?: number;
  usagePerDay?: Record<string, number>;
  meterPollSeconds?: number;
  meterStalenessMinutes?: number;
  /** Typed-in limits for estimated meters, keyed by meter id. */
  estimatedLimits?: Record<string, number>;
  /** 1–3600 s; overrides the destination type's per-target and default timeouts. */
  invokeTimeoutSeconds?: number;
}
