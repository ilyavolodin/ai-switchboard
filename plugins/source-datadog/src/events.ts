import type { Attributes, EventTypeSpec } from '@ai-switchboard/sdk';
import { attr, flatAttributesSchema } from '@ai-switchboard/sdk/schema';

const S = attr.string;

const attributes = flatAttributesSchema(
  {
    monitorId: S('The monitor id ($ALERT_ID).'),
    title: S('Alert title ($ALERT_TITLE).'),
    transition: S(
      'Datadog’s transition as sent ($ALERT_TRANSITION), e.g. `Triggered`, `Re-Triggered`.',
    ),
    alertType: S('`error`, `warning`, `success` or `info` ($ALERT_TYPE).'),
    priority: S('Monitor priority, e.g. `P1` … `P5`, or `Normal` ($PRIORITY).'),
    tags: attr.strings('Monitor and group tags ($TAGS), e.g. `env:prod`.'),
    hostname: S('Host that triggered, when there is one ($HOSTNAME).'),
    metric: S('Metric the monitor evaluates ($ALERT_METRIC).'),
    scope: S('The group (scope) that transitioned, e.g. `service:api,env:prod` ($ALERT_SCOPE).'),
    orgId: S('Datadog organization id ($ORG_ID).'),
  },
  ['monitorId', 'title', 'transition', 'tags'],
);

const example: Attributes = {
  monitorId: '148275309',
  title: '[P1] API 5xx rate above 2% on env:prod',
  transition: 'Triggered',
  alertType: 'error',
  priority: 'P1',
  tags: ['env:prod', 'service:api', 'team:payments'],
  hostname: 'api-prod-7f9c',
  metric: 'trace.http.request.errors',
  scope: 'env:prod,service:api',
  orgId: '421337',
};

function spec(
  verb: string,
  title: string,
  description: string,
  overrides: Attributes,
): EventTypeSpec {
  return {
    type: `datadog.monitor.${verb}`,
    title,
    description,
    attributes,
    examples: [{ ...example, ...overrides }],
  };
}

export const eventTypes: EventTypeSpec[] = [
  spec(
    'triggered',
    'Monitor triggered',
    'A monitor entered the alert state. Unrecognised transitions are also reported here, with `transition` carrying Datadog’s value.',
    {},
  ),
  spec('recovered', 'Monitor recovered', 'A monitor returned to OK.', {
    transition: 'Recovered',
    alertType: 'success',
    title: '[Recovered] [P1] API 5xx rate above 2% on env:prod',
  }),
  spec('warn', 'Monitor warning', 'A monitor entered the warning state.', {
    transition: 'Warn',
    alertType: 'warning',
    title: '[Warn] [P1] API 5xx rate above 2% on env:prod',
  }),
  spec('no_data', 'Monitor has no data', 'A monitor stopped receiving data.', {
    transition: 'No Data',
    alertType: 'error',
    title: '[No Data] [P1] API 5xx rate above 2% on env:prod',
  }),
  spec(
    'renotify',
    'Monitor re-notified',
    'A monitor still in alert, warning or no-data sent a re-notification (Re-Triggered, Re-Warn, Re-No Data, Renotify).',
    { transition: 'Re-Triggered', title: '[Re-Triggered] [P1] API 5xx rate above 2% on env:prod' },
  ),
];
