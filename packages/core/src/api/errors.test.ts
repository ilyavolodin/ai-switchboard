import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  conflict,
  DomainError,
  invalid,
  notFound,
  unavailable,
  unprocessable,
} from '../services/errors.js';
import { RecoveryError } from '../services/recovery.js';
import { registerErrorHandler } from './errors.js';

describe('error handler', () => {
  it.each([
    ['not found', notFound('Run'), 404, 'not_found'],
    ['a conflict', conflict('taken'), 409, 'conflict'],
    ['an invalid pipeline request', invalid('no such type'), 400, 'invalid'],
    ['unavailable', unavailable('no live instance'), 503, 'unavailable'],
    ['unprocessable', unprocessable('cannot', ['a']), 422, 'unprocessable'],
    ['a custom code', new DomainError('too_many_attempts', 'wait', { code: 'slow' }), 429, 'slow'],
    ['a recovery error', new RecoveryError('unknown_user', 'no one'), 404, 'unknown_user'],
  ] as const)('maps %s to its status and code', async (_name, err, status, code) => {
    const app = Fastify();
    registerErrorHandler(app);
    app.get('/x', () => {
      throw err;
    });
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: code, message: err.message });
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
