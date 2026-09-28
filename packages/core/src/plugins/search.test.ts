import { describe, expect, it } from 'vitest';

import {
  filterPluginPackages,
  isRegistryUnavailableError,
  searchRegistry,
  searchTexts,
  type RegistryFetch,
} from './search.js';

const object = (name: string, extra: Record<string, unknown> = {}) => ({
  package: {
    name,
    version: '1.0.0',
    description: `${name} description`,
    date: '2026-01-02T03:04:05.000Z',
    publisher: { username: 'acme-dev', email: 'dev@acme.test' },
    links: { npm: `https://www.npmjs.com/package/${name}`, homepage: 'https://acme.test' },
    ...extra,
  },
  downloads: { monthly: 400, weekly: 100 },
});

/** A registry stub answering by the `text` parameter; records every URL. */
function stubRegistry(byText: Record<string, unknown[]>): RegistryFetch & { urls: string[] } {
  const urls: string[] = [];
  const fn = (url: string) => {
    urls.push(url);
    const text = new URL(url).searchParams.get('text') ?? '';
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ objects: byText[text] ?? [], total: 0 }),
    });
  };
  return Object.assign(fn, { urls });
}

describe('registry search', () => {
  it('queries the name prefix and the keyword, with the text the person typed', () => {
    expect(searchTexts('source', '')).toEqual([
      'ai-switchboard-source',
      'keywords:switchboard-plugin',
    ]);
    expect(searchTexts(undefined, ' jira ')).toEqual([
      'ai-switchboard jira',
      'keywords:switchboard-plugin jira',
    ]);
  });

  it('keeps the union of both queries that follows the convention, once each', async () => {
    const registry = stubRegistry({
      'ai-switchboard-source': [
        object('ai-switchboard-source-jira'),
        object('@acme/ai-switchboard-source-sentry'),
        object('ai-switchboard-sourcerer'),
      ],
      'keywords:switchboard-plugin': [
        object('@ai-switchboard/source-webhook'),
        object('ai-switchboard-source-jira'),
        object('@ai-switchboard/destination-http'),
        object('@ai-switchboard/sdk'),
        object('left-pad'),
      ],
    });
    const found = await searchRegistry({
      registry: 'https://registry.test/',
      kind: 'source',
      fetch: registry,
    });
    expect(found.map((p) => p.name)).toEqual([
      'ai-switchboard-source-jira',
      '@acme/ai-switchboard-source-sentry',
      '@ai-switchboard/source-webhook',
    ]);
    expect(found[0]).toEqual({
      name: 'ai-switchboard-source-jira',
      kind: 'source',
      version: '1.0.0',
      description: 'ai-switchboard-source-jira description',
      publisher: 'acme-dev',
      date: '2026-01-02T03:04:05.000Z',
      links: {
        npm: 'https://www.npmjs.com/package/ai-switchboard-source-jira',
        homepage: 'https://acme.test',
      },
      weeklyDownloads: 100,
    });
    expect(registry.urls).toEqual([
      'https://registry.test/-/v1/search?text=ai-switchboard-source&size=50',
      'https://registry.test/-/v1/search?text=keywords%3Aswitchboard-plugin&size=50',
    ]);
  });

  it('without a kind keeps every kind', () => {
    const found = filterPluginPackages(
      [
        {
          objects: [
            object('@ai-switchboard/secrets-env'),
            object('ai-switchboard-notifier-teams'),
            { package: { name: 'no-version' } },
            'garbage',
          ],
        },
        null,
      ],
      undefined,
    );
    expect(found.map((p) => [p.name, p.kind])).toEqual([
      ['@ai-switchboard/secrets-env', 'secrets'],
      ['ai-switchboard-notifier-teams', 'notifier'],
    ]);
  });

  it('reports an unreachable or failing registry as unavailable', async () => {
    const offline: RegistryFetch = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const err = await searchRegistry({ registry: 'https://registry.test', fetch: offline }).catch(
      (e: unknown) => e,
    );
    expect(isRegistryUnavailableError(err)).toBe(true);
    expect((err as Error).message).toMatch(/unreachable.*ENOTFOUND/);

    const failing: RegistryFetch = () =>
      Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
    await expect(
      searchRegistry({ registry: 'https://registry.test', fetch: failing }),
    ).rejects.toThrow(/answered 502/);
  });
});
