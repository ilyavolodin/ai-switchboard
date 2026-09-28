/**
 * The configuration the e2e suite runs against, applied through `POST /api/v1/apply`, and the
 * pipeline outcomes it waits for before any test starts.
 *
 * One webhook source feeds three processes, routed by the alert's `route` attribute:
 * - "Breaker demo" calls the stub's `/exec/callback?outcome=error`; the error callback closes the
 *   run as `error` and a breaker threshold of 1 opens the breaker.
 * - "Healthy alerts" calls `/exec` synchronously and finishes `ok`.
 * - "Approval demo" waits for an approval.
 * The `http` destination reads the stub's `/meter` as its `endpoint` meter (30 of 100 requests).
 */
import type {
  ApplyResponse,
  ApprovalItem,
  DestinationSummary,
  ProcessDetail,
  ProcessSummary,
  RunSummary,
  Page,
  SourceSummary,
} from '@ai-switchboard/core/contract';

import { Api, sendAlert, waitFor, type StackState } from './stack.js';

export const SOURCE = 'Stub alerts';
export const DESTINATION = 'Stub HTTP';
export const BREAKER_PROCESS = 'Breaker demo';
export const HEALTHY_PROCESS = 'Healthy alerts';
export const APPROVAL_PROCESS = 'Approval demo';

function process(
  name: string,
  route: string,
  target: Record<string, unknown>,
  gates: { approval: string; threshold: number },
): string {
  return `
  - name: ${name}
    description: Alerts routed "${route}" start one call to the stub.
    enabled: true
    triggers:
      - id: t1
        source: ${SOURCE}
        eventTypes: [webhook.alert.fired]
        filter: attributes.route = '${route}'
        describe: A "${route}" alert fired
        enabled: true
    schedules: []
    batching: { debounceSeconds: 1, maxSize: 20, maxAgeSeconds: 5 }
    gates:
      approval: ${gates.approval}
      breaker: { threshold: ${gates.threshold}, cooldownMinutes: 0 }
    budgets:
      runsPerHour: 30
      runsPerDay: 200
      usagePerDay: { cost_usd: 5 }
      meterCeilings: {}
    destination:
      instance: ${DESTINATION}
      target: ${JSON.stringify(target)}
    input: |
      { "mode": mode, "runId": run.id, "alerts": events.{ "id": artifact.id, "service": attributes.service } }
    before: []
    after: []
    notify: []
    trackingDeadlineMinutes: 10
`;
}

export function seedYaml(stubUrl: string): string {
  return `apiVersion: switchboard/v1
kind: Configuration

settings:
  timezone: UTC

secretProviders:
  - name: env
    type: env
    enabled: true
    settings: {}

sources:
  - name: ${SOURCE}
    type: webhook
    enabled: true
    settings:
      verification: hmac
      secret: secret://env/WEBHOOK_SECRET
      signatureHeader: x-signature-256
      signaturePrefix: sha256=
      algorithm: sha256
      signatureEncoding: hex
      eventTypes:
        - type: webhook.alert.fired
          title: Alert fired
          description: The stub reports an alert for a service.
          attributes:
            - { name: service, type: string }
            - { name: severity, type: string }
            - { name: message, type: string }
            - { name: route, type: string, description: Which e2e process handles it }
          example: { service: checkout, severity: critical, message: Error rate above 5%, route: healthy }
      mapping: |
        {
          "type": "webhook.alert.fired",
          "artifact": { "kind": "alert", "id": body.id },
          "attributes": {
            "service": body.service,
            "severity": body.severity,
            "message": body.message,
            "route": body.type
          },
          "occurredAt": body.occurredAt
        }
    caps:
      eventCapPerHour: 1000

destinations:
  - name: ${DESTINATION}
    type: http
    enabled: true
    settings:
      baseUrl: ${stubUrl}
      headers: {}
      callbackSecret: secret://env/STUB_CALLBACK_SECRET
      meterEndpoint: /meter
      meterUnit: requests
      usageDimensions:
        - { id: duration_seconds, title: Duration, unit: seconds, aggregate: sum, budgetable: true }
        - { id: response_bytes, title: Response size, unit: bytes, aggregate: sum, budgetable: false }
        - { id: cost_usd, title: Cost, unit: usd, aggregate: sum, budgetable: true }
    caps:
      runsPerDay: 500

processes:${process(
    BREAKER_PROCESS,
    'breaker',
    {
      method: 'POST',
      url: '/exec/callback?outcome=error&delay=200',
      tracking: 'callback',
      idempotent: false,
    },
    { approval: 'none', threshold: 1 },
  )}${process(
    HEALTHY_PROCESS,
    'healthy',
    {
      method: 'POST',
      url: '/exec',
      tracking: 'sync',
      idempotent: false,
      usageFrom: '{ "cost_usd": response.body.usage.cost_usd }',
      timeoutSeconds: 10,
    },
    { approval: 'none', threshold: 3 },
  )}${process(
    APPROVAL_PROCESS,
    'approval',
    { method: 'POST', url: '/exec', tracking: 'sync', idempotent: false },
    { approval: 'always', threshold: 3 },
  )}`;
}

function byName<T extends { name: string }>(items: T[], name: string): T {
  const found = items.find((i) => i.name === name);
  if (!found) throw new Error(`seed: no "${name}" after apply`);
  return found;
}

/** Apply the configuration, send one alert per process and wait for each outcome. */
export async function seed(baseUrl: string, stubUrl: string): Promise<StackState> {
  const api = await Api.signIn(baseUrl);
  const applied = await api.post<ApplyResponse>('/api/v1/apply', {
    yaml: seedYaml(stubUrl),
    reason: 'e2e seed',
  });
  if (applied.errors.length > 0) throw new Error(`apply failed: ${applied.errors.join('; ')}`);

  const source = byName(await api.get<SourceSummary[]>('/api/v1/sources'), SOURCE);
  const destination = byName(
    await api.get<DestinationSummary[]>('/api/v1/destinations'),
    DESTINATION,
  );
  const processes = await api.get<ProcessSummary[]>('/api/v1/processes');
  const breaker = byName(processes, BREAKER_PROCESS);
  const healthy = byName(processes, HEALTHY_PROCESS);
  const approval = byName(processes, APPROVAL_PROCESS);

  await api.post('/api/v1/destinations/' + destination.id + '/meters/read', { reason: 'e2e seed' });

  const artifactId = await sendAlert(stubUrl, baseUrl, source.id, 'healthy');
  await sendAlert(stubUrl, baseUrl, source.id, 'breaker');
  await sendAlert(stubUrl, baseUrl, source.id, 'approval');

  await waitFor('the healthy run to finish ok', async () => {
    const runs = await api.get<Page<RunSummary>>(`/api/v1/runs?process=${healthy.id}`);
    return runs.items.some((r) => r.status === 'ok') ? true : undefined;
  });
  await waitFor('the breaker to open', async () => {
    const detail = await api.get<ProcessDetail>(`/api/v1/processes/${breaker.id}`);
    return detail.breakerState === 'open' ? true : undefined;
  });
  await waitFor('the approval to be pending', async () => {
    const pending = await api.get<ApprovalItem[]>('/api/v1/approvals');
    return pending.some((a) => a.process.id === approval.id) ? true : undefined;
  });

  return {
    baseUrl,
    stubUrl,
    token: api.token,
    sourceId: source.id,
    destinationId: destination.id,
    breakerProcessId: breaker.id,
    healthyProcessId: healthy.id,
    approvalProcessId: approval.id,
    artifactId,
  };
}
