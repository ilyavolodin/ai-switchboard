import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { PipelineError } from '../services/pipeline/errors.js';
import { registerErrorHandler } from './errors.js';

describe('error handler', () => {
  it.each([
    ['not_found', 404],
    ['conflict', 409],
    ['invalid', 400],
    ['unavailable', 503],
  ] as const)('maps a PipelineError %s to %i with its message', async (code, status) => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/x', () => {
      throw new PipelineError(code, `pipeline said ${code}`);
    });
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code, message: `pipeline said ${code}` });
    await app.close();
  });

  it('answers 409 when a unique constraint refuses a write that raced another', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/x', () => {
      // What drizzle raises: the driver's error as the cause.
      throw Object.assign(new Error('Failed query'), {
        cause: { code: '23505', constraint: 'secret_providers_name' },
      });
    });
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'conflict' });
    await app.close();
  });
});
