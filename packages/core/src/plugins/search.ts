import {
  isDiscoverablePluginName,
  parsePluginPackageName,
  PLUGIN_KEYWORD,
  PLUGIN_NAME_PREFIX,
  type PluginNameKind,
} from './naming.js';

export type RegistryFetch = (
  url: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** `message` is shown to the admin. */
export class RegistryUnavailableError extends Error {
  override readonly name = 'RegistryUnavailableError';
}

export function isRegistryUnavailableError(err: unknown): err is RegistryUnavailableError {
  return err instanceof Error && err.name === 'RegistryUnavailableError';
}

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
  registry: string;
  kind?: PluginNameKind;
  q?: string;
  /** Per registry query; npm caps it at 250. */
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

export function searchTexts(kind: PluginNameKind | undefined, q: string): string[] {
  const words = q.trim();
  const prefix = kind ? `${PLUGIN_NAME_PREFIX}${kind}` : PLUGIN_NAME_PREFIX.replace(/-$/, '');
  const withQ = (base: string) => (words ? `${base} ${words}` : base);
  return [withQ(prefix), withQ(`keywords:${PLUGIN_KEYWORD}`)];
}

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

/** Throws rather than returning an empty list so the API can say the registry is unreachable. */
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
