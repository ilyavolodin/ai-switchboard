import type { Health, JSONSchema } from '@ai-switchboard/sdk';

import type { InstanceKind } from '../../domain/status.js';
import type { Iso, Reasoned, StatusLabel } from './common.js';
import { bodySchema } from './schema.js';

/** A notifier or secret provider (sources and destinations have their own DTOs). */
export interface InstanceSummary {
  id: string;
  kind: 'notifier' | 'secret_provider';
  typeId: string;
  typeName: string;
  typeIcon: string | null;
  name: string;
  enabled: boolean;
  status: StatusLabel;
  health: Health | null;
  settings: Record<string, unknown>;
  settingsSchema: JSONSchema;
  instanceError: string | null;
  /**
   * Secret providers only: the instances referencing `secret://<this name>/…`. A mutation rebuilds
   * them first, so its response shows the outcome.
   */
  dependents?: SecretProviderDependentDTO[];
}

export interface SecretProviderDependentDTO {
  kind: 'source' | 'destination' | 'notifier';
  id: string;
  name: string;
  status: StatusLabel;
  /** Why it is not running (`secret_error: …` when a reference no longer resolves). */
  instanceError: string | null;
}

export interface CreateInstanceRequest extends Reasoned {
  typeId: string;
  name: string;
  settings: Record<string, unknown>;
  enabled?: boolean;
}

export const createInstanceBody = bodySchema<CreateInstanceRequest>()({
  type: 'object',
  required: ['reason', 'typeId', 'name', 'settings'],
  properties: {
    reason: { type: 'string' },
    typeId: { type: 'string', minLength: 1 },
    name: { type: 'string' },
    settings: { type: 'object' },
    enabled: { type: 'boolean' },
  },
});

export interface UpdateInstanceRequest extends Reasoned {
  name?: string;
  settings?: Record<string, unknown>;
}

export const updateInstanceBody = bodySchema<UpdateInstanceRequest>()({
  type: 'object',
  required: ['reason'],
  properties: {
    reason: { type: 'string' },
    name: { type: 'string' },
    settings: { type: 'object' },
  },
});

/** Something whose settings (or, for a process, whose document) hold a `secret://` reference. */
export interface SecretUserDTO {
  kind: InstanceKind | 'process';
  id: string;
  name: string;
  /** Dotted path of the field holding the reference (`apiKey`, `destination.target.token`). */
  field: string;
}

/**
 * One secret a provider lists. Names only: the API never returns a secret value, nor anything
 * derived from one.
 */
export interface ProviderSecretDTO {
  name: string;
  /** `secret://<provider>/<name>`, ready to paste into a secret field. */
  ref: string;
  description?: string;
  updatedAt?: Iso;
  usedBy: SecretUserDTO[];
  /**
   * Set when the host stored this name for an instance's rotated credentials
   * (`switchboard-<instanceId>-<key>`). The host owns it: it is not a settings reference.
   */
  storedBy?: SecretOwnerDTO;
}

/** The instance a host-stored secret belongs to. */
export interface SecretOwnerDTO {
  kind: InstanceKind;
  id: string;
  name: string;
}

/** A reference to this provider whose name the provider does not list (a broken reference). */
export interface MissingSecretDTO {
  name: string;
  ref: string;
  usedBy: SecretUserDTO[];
}

/** GET /secret-providers/:id/secrets */
export interface ProviderSecretsResponse {
  providerId: string;
  /** The provider's name: the `<provider>` in `secret://<provider>/<name>`. */
  provider: string;
  /**
   * False when the provider cannot list (its plugin has no `list()`, it is disabled or not
   * running, or listing failed); `error` says why and `secrets` and `missing` are empty.
   */
  available: boolean;
  error?: string;
  secrets: ProviderSecretDTO[];
  missing: MissingSecretDTO[];
}
