import type { Health } from './types/common.js';

export type HealthProbe = () => Promise<Omit<Health, 'checkedAt'>>;

/** Runs `probe`, stamps `checkedAt`, and turns a throw into `unhealthy` with its message. */
export async function checkHealth(ctx: { now(): Date }, probe: HealthProbe): Promise<Health> {
  try {
    const result = await probe();
    return { ...result, checkedAt: ctx.now().toISOString() };
  } catch (err) {
    return {
      status: 'unhealthy',
      message: err instanceof Error ? err.message : String(err),
      checkedAt: ctx.now().toISOString(),
    };
  }
}
