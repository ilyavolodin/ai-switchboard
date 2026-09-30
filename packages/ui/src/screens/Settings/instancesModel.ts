import type { InstanceRoute } from '../../api/index.js';
import type { ReasonPromptOptions } from '../../hooks/reason.js';

export interface InstanceRouteCopy {
  title: string;
  one: 'notifier' | 'secret provider';
  kind: 'notifier' | 'secret_provider';
  subtitle: string;
  empty: string;
  namePlaceholder: string;
  canTest: boolean;
  hasSecrets: boolean;
}

export const INSTANCE_ROUTES: Record<InstanceRoute, InstanceRouteCopy> = {
  notifiers: {
    title: 'Notifiers',
    one: 'notifier',
    kind: 'notifier',
    subtitle: 'where breakers, approvals and process notifications are posted',
    empty: 'Add a notifier (Slack, a webhook) so breakers and approvals reach people.',
    namePlaceholder: 'Slack — #loops',
    canTest: true,
    hasSecrets: false,
  },
  'secret-providers': {
    title: 'Secret providers',
    one: 'secret provider',
    kind: 'secret_provider',
    subtitle: 'resolve secret://<provider>/<name> references; values never reach the database',
    empty: 'Add a secret provider so settings can reference secrets instead of holding them.',
    namePlaceholder: 'vault',
    canTest: false,
    hasSecrets: true,
  },
};

export function enableInstancePrompt(
  route: InstanceRoute,
  name: string,
  enabled: boolean,
): ReasonPromptOptions {
  const copy = INSTANCE_ROUTES[route];
  return {
    title: `${enabled ? 'Enable' : 'Disable'} ${name}?`,
    consequence: enabled
      ? `The ${copy.one} is used again from now on.`
      : route === 'notifiers'
        ? 'Notifications routed to it are dropped until it is enabled again.'
        : 'References to it stop resolving; instances that need them fail to reload.',
    confirmLabel: enabled ? 'Enable' : 'Disable',
    danger: !enabled,
  };
}

export function addInstancePrompt(route: InstanceRoute, name: string): ReasonPromptOptions {
  const { one } = INSTANCE_ROUTES[route];
  return { title: `Add the ${one} “${name}”?`, confirmLabel: `Add ${one}` };
}

export function saveInstancePrompt(
  route: InstanceRoute,
  name: string | undefined,
): ReasonPromptOptions {
  return {
    title: `Save ${name ?? INSTANCE_ROUTES[route].one}?`,
    consequence: 'The instance reloads with the new settings.',
    confirmLabel: 'Save',
  };
}

export function testNotifierPrompt(name: string): ReasonPromptOptions {
  return { title: `Send a test notification to ${name}?`, confirmLabel: 'Send test' };
}

export function deleteInstancePrompt(route: InstanceRoute, name: string): ReasonPromptOptions {
  return {
    title: `Delete ${name}?`,
    consequence:
      route === 'notifiers'
        ? 'Processes that notify through it stop notifying.'
        : `Every secret://${name}/… reference stops resolving.`,
    confirmLabel: 'Delete',
    danger: true,
  };
}
