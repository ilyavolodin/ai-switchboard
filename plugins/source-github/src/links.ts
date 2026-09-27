import type { ArtifactRef } from '@ai-switchboard/sdk';

/** Upper-case prefixes that look like tracker keys but are standards and encodings. */
const NOT_TRACKER_KEYS = new Set([
  'UTF',
  'SHA',
  'ISO',
  'RFC',
  'CVE',
  'CWE',
  'GHSA',
  'HTTP',
  'TLS',
  'SSL',
  'PEP',
  'AES',
  'RSA',
  'ECMA',
]);

// Linear identifiers: a 2–7 character team key, a dash, a number (`LOL-1712`).
const LINEAR_ID = /(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{1,6})-([1-9][0-9]{0,6})(?![A-Za-z0-9_-])/g;
// GitHub's closing keywords: `Fixes #12`, `closes acme/api#12`, `Resolved: #3`.
const CLOSING =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([0-9]+)\b/gi;
// Cross-repository references anywhere: `acme/web#12`.
const CROSS_REPO = /(?<![A-Za-z0-9_./-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([0-9]+)\b/g;
// Links: `https://github.com/acme/api/issues/12` and `/pull/7`.
const GITHUB_URL =
  /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([0-9]+)\b/g;

/** Code blocks and inline code are not references. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/**
 * Tracker references in a pull request's (or issue's) text: Linear identifiers as
 * `linear.issue`, GitHub closing keywords, cross-repository refs and links as `github.issue`
 * (or `github.pr` for `/pull/` links). `self` (`acme/api#482`) is excluded. Pure.
 */
export function extractLinks(text: string, selfRepo: string, selfId: string): ArtifactRef[] {
  const clean = stripCode(text);
  const out: ArtifactRef[] = [];
  const seen = new Set<string>();
  const add = (kind: string, id: string): void => {
    const key = `${kind}:${id.toLowerCase()}`;
    if (id.toLowerCase() === selfId.toLowerCase() || seen.has(key)) return;
    seen.add(key);
    out.push({ kind, id });
  };
  const ordered: { index: number; kind: string; id: string }[] = [];
  for (const m of clean.matchAll(LINEAR_ID)) {
    const [, key = '', n = ''] = m;
    if (!NOT_TRACKER_KEYS.has(key))
      ordered.push({ index: m.index, kind: 'linear.issue', id: `${key}-${n}` });
  }
  for (const m of clean.matchAll(CLOSING)) {
    const [, owner, repo, n = ''] = m;
    const full = owner !== undefined && repo !== undefined ? `${owner}/${repo}` : selfRepo;
    ordered.push({ index: m.index, kind: 'github.issue', id: `${full}#${n}` });
  }
  for (const m of clean.matchAll(CROSS_REPO)) {
    const [, owner = '', repo = '', n = ''] = m;
    ordered.push({ index: m.index, kind: 'github.issue', id: `${owner}/${repo}#${n}` });
  }
  for (const m of clean.matchAll(GITHUB_URL)) {
    const [, owner = '', repo = '', what, n = ''] = m;
    ordered.push({
      index: m.index,
      kind: what === 'pull' ? 'github.pr' : 'github.issue',
      id: `${owner}/${repo}#${n}`,
    });
  }
  ordered.sort((a, b) => a.index - b.index);
  for (const r of ordered) add(r.kind, r.id);
  return out;
}
