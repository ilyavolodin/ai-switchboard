import { describe, expect, it } from 'vitest';

import { TEST_NOW } from '../test/constants.js';
import { buildFixtures, IDS } from './fixtures.js';
import { createMockApi } from './mockApi.js';

async function send(
  api: ReturnType<typeof createMockApi>,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await api.fetch(`/api/v1${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as Record<string, unknown>;
}

describe('createMockApi', () => {
  it('merges a PUT body into the row, echoes it and serves it afterwards', async () => {
    const api = createMockApi({ fixtures: buildFixtures(TEST_NOW) });
    const id = IDS.sources.linear;
    const echoed = await send(api, 'PUT', `/sources/${id}`, { reason: 'rename', name: 'Linear 2' });
    expect(echoed).toMatchObject({ id, name: 'Linear 2' });
    expect(echoed).not.toHaveProperty('reason');
    expect(await send(api, 'GET', `/sources/${id}`)).toMatchObject({ name: 'Linear 2' });
    expect(api.fixtures.sources.find((s) => s.id === id)?.name).toBe('Linear 2');
  });

  it('creates a row with a new id from a POST', async () => {
    const api = createMockApi({ fixtures: buildFixtures(TEST_NOW) });
    const created = await send(api, 'POST', '/destinations', {
      reason: 'add',
      typeId: 'http',
      name: 'Hook',
      settings: {},
    });
    expect(created).toMatchObject({ id: 'ex-new-1', name: 'Hook', typeId: 'http' });
    expect(await send(api, 'GET', '/destinations/ex-new-1')).toMatchObject({ name: 'Hook' });
  });

  it('bumps the version when a process document is saved', async () => {
    const api = createMockApi({ fixtures: buildFixtures(TEST_NOW) });
    const before = await send(api, 'GET', `/processes/${IDS.processes.autofix}`);
    const document = { ...(before.document as object), name: 'Autofix v2' };
    const saved = await send(api, 'PUT', `/processes/${IDS.processes.autofix}`, {
      reason: 'rename',
      document,
      expectedVersion: before.version,
    });
    expect(saved).toMatchObject({ name: 'Autofix v2', version: Number(before.version) + 1 });
  });
});
