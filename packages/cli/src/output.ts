import type { Capabilities } from '@ai-switchboard/sdk';

// Plain text, no colour, stable for scripts.

export const OK = '✓';
export const FAIL = '✗';

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

export function fields(pairs: [string, string][], indent = '  '): string {
  const width = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${indent}${k.padEnd(width)}  ${v}`).join('\n');
}

/** Enough to compare by eye; the lockfile keeps the full hash. */
export function shortIntegrity(integrity: string | null, length = 20): string {
  if (integrity === null || integrity === '') return '-';
  return integrity.length > length ? `${integrity.slice(0, length)}…` : integrity;
}

export function formatCapabilities(capabilities: Capabilities | undefined): string {
  if (capabilities === undefined) return '  (could not be read; review the package source)';
  const network = capabilities.network ?? [];
  const secrets = capabilities.secrets ?? [];
  const lines: [string, string][] = [
    ['network', network.length > 0 ? network.join(', ') : '(none declared)'],
    ['secrets', secrets.length > 0 ? secrets.join(', ') : '(none declared)'],
  ];
  const out = fields(lines);
  return network.includes('*')
    ? `${out}\n  note: "*" lets the plugin's HttpClient reach any host`
    : out;
}

export function checkLine(ok: boolean, name: string, detail: string): string {
  return `${ok ? OK : FAIL} ${name}${detail !== '' ? ` — ${detail}` : ''}`;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
