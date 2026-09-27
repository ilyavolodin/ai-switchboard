/**
 * Shapes of the Routines trigger, OAuth token and seat usage responses. Values are fake; the
 * usage shape mirrors what Claude Code's `/usage` command reads.
 */

export const fireResponse = {
  type: 'routine_fire',
  id: 'session_01FixtureSession',
  session_url: 'https://claude.ai/code/session_01FixtureSession',
};

/** The variant with Claude Code-prefixed field names. */
export const fireResponsePrefixed = {
  claude_code_session_id: 'session_01Prefixed',
  claude_code_session_url: 'https://claude.ai/code/session_01Prefixed',
};

export const pausedError = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'Routine trig_01ABCDEF is paused' },
};

export const rateLimitError = {
  type: 'error',
  error: { type: 'rate_limit_error', message: 'Daily routine run limit reached' },
};

export const authError = {
  type: 'error',
  error: { type: 'authentication_error', message: 'invalid bearer token' },
};

export function tokenResponse(n: number): Record<string, unknown> {
  return {
    token_type: 'Bearer',
    access_token: `fixture-access-${n}`,
    refresh_token: `fixture-refresh-${n}`,
    expires_in: 28_800,
    scope: 'user:inference user:profile',
  };
}

export const usageResponse = {
  five_hour: { utilization: 37, resets_at: '2026-09-27T13:00:00.000Z' },
  seven_day: { utilization: 61.5, resets_at: '2026-10-01T08:00:00.000Z' },
  seven_day_opus: null,
  extra_usage: { is_enabled: false },
};
