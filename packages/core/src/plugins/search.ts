import {
  isDiscoverablePluginName,
  parsePluginPackageName,
  PLUGIN_KEYWORD,
  PLUGIN_NAME_PREFIX,
  type PluginNameKind,
} from './naming.js';

/**
 * Searching the npm registry for plugin packages (`GET /-/v1/search`). The registry is read
 * through an injected {@link RegistryFetch} so tests never reach the network.
 */

/** The subset of `fetch` the registry search uses; the global `fetch` satisfies it. */
export type RegistryFetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The registry did not answer (offline install, proxy, outage); `message` is for the admin. */
export class RegistryUnavailableError extends Error {
  override readonly name = 'RegistryUnavailableError';
}

export function isRegistryUnavailableError(err: unknown): err is RegistryUnavailableError {
  return err instanceof Error && err.name === 'RegistryUnavailableError';
}

/** One package the registry returned, normalized. */
export interface RegistryPackage {
  name: string;
  kind: PluginNameKind;
  version: string;
  description: string;
  publisher: string | null;
  date: string | null;
  links: { npm?: string; homepage?: string; repository?: string };
  weeklyDownloads: number | null;
}

export interface SearchRegistryOptions {
  /** Base URL of the registry, e.g. `https://registry.npmjs.org`. */
  registry: string;
  kind?: PluginNameKind;
  /** Free text the person typed (may be empty). */
  q?: string;
  /** Results per registry query (npm caps it at 250). */
  size?: number;
  fetch?: RegistryFetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The two registry queries whose union is the result: the name prefix and the keyword. */
export function searchTexts(kind: PluginNameKind | undefined, q: string): string[] {
  const words = q.trim();
  const prefix = kind ? `${PLUGIN_NAME_PREFIX}${kind}` : PLUGIN_NAME_PREFIX.replace(/-$/, '');
  const withQ = (base: string) => (words ? `${base} ${words}` : base);
  return [withQ(prefix), withQ(`keywords:${PLUGIN_KEYWORD}`)];
}

/** Reads one `objects[]` entry of a registry search response; `null` when it is unusable. */
export function readSearchObject(value: unknown): Omit<RegistryPackage, 'kind'> | null {
  if (!isRecord(value) || !isRecord(value.package)) return null;
  const p = value.package;
  const name = str(p.name);
  const version = str(p.version);
  if (!name || !version) return null;
  const links = isRecord(p.links) ? p.links : {};
  const publisher = isRecord(p.publisher) ? str(p.publisher.username) : undefined;
  const downloads = isRecord(value.downloads) ? value.downloads.weekly : undefined;
  return {
    name,
    version,
    description: str(p.description) ?? '',
    publisher: publisher ?? null,
    date: str(p.date) ?? null,
    links: {
      ...(str(links.npm) ? { npm: str(links.npm) } : {}),
      ...(str(links.homepage) ? { homepage: str(links.homepage) } : {}),
      ...(str(links.repository) ? { repository: str(links.repository) } : {}),
    },
    weeklyDownloads: typeof downloads === 'number' ? downloads : null,
  };
}

/**
 * Keeps the packages that follow the naming convention (and name `kind` when given), without
 * duplicates, in the registry's order.
 */
export function filterPluginPackages(
  responses: unknown[],
  kind: PluginNameKind | undefined,
): RegistryPackage[] {
  const seen = new Map<string, RegistryPackage>();
  for (const response of responses) {
    const objects = isRecord(response) && Array.isArray(response.objects) ? response.objects : [];
    for (const object of objects as unknown[]) {
      const pkg = readSearchObject(object);
      if (!pkg || seen.has(pkg.name) || !isDiscoverablePluginName(pkg.name, kind)) continue;
      const parsed = parsePluginPackageName(pkg.name);
      if (parsed) seen.set(pkg.name, { ...pkg, kind: parsed.kind });
    }
  }
  return [...seen.values()];
}

const defaultFetch: RegistryFetch = (url, init) => fetch(url, init);

/**
 * Runs the prefix and keyword queries against the registry and returns their filtered union.
 * Throws {@link RegistryUnavailableError} when the registry cannot be reached or answers with an
 * error, so the API can say so instead of showing an empty list.
 */
export async function searchRegistry(options: SearchRegistryOptions): Promise<RegistryPackage[]> {
  const base = options.registry.replace(/\/+$/, '');
  const size = Math.min(Math.max(options.size ?? 50, 1), 250);
  const doFetch = options.fetch ?? defaultFetch;
  const responses = await Promise.all(
    searchTexts(options.kind, options.q ?? '').map(async (text) => {
      const url = `${base}/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
      let res: Awaited<ReturnType<RegistryFetch>>;
      try {
        res = await doFetch(url, {
          signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
          headers: { accept: 'application/json' },
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new RegistryUnavailableError(
          `The npm registry at ${base} is unreachable (${detail}).`,
        );
      }
      if (!res.ok) {
        throw new RegistryUnavailableError(
          `The npm registry at ${base} answered ${res.status} to a search.`,
        );
      }
      try {
        return await res.json();
      } catch {
        throw new RegistryUnavailableError(`The npm registry at ${base} did not return JSON.`);
      }
    }),
  );
  return filterPluginPackages(responses, options.kind);
}
