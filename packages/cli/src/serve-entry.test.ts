import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveServerEntry } from './serve-entry.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sb-serve-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@ai-switchboard/core' }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('resolveServerEntry', () => {
  it('walks up from a resolved module to the package root and returns dist/main.js', async () => {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'main.js'), '');
    const url = pathToFileURL(join(root, 'src', 'index.ts')).href;
    expect(await resolveServerEntry(url)).toBe(join(root, 'dist', 'main.js'));
  });

  it('says to build first when dist/main.js is missing', async () => {
    const url = pathToFileURL(join(root, 'src', 'index.ts')).href;
    await expect(resolveServerEntry(url)).rejects.toThrow(/build the core first/);
  });
});
