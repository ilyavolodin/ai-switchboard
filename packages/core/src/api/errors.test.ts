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
});
