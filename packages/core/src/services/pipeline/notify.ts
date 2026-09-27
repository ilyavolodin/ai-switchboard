import { and, eq } from 'drizzle-orm';

import type { Event, NotificationMessage } from '@ai-switchboard/sdk';

import { notificationLog, systemAlerts } from '../../db/schema.js';
import { renderTemplate } from '../../expr/index.js';
import { getSettings } from '../settings.js';

import {
  errorMessage,
  evalFunctions,
  processView,
  withTx,
  type Ctx,
  type ProcessRow,
} from './context.js';

/**
 * Notifications: per-process notifications on a batch or run outcome (the process's `notify`
 * list, each rendered from its template), and system alerts to the installation's system
 * notifier, rate-limited per subject. Every send is logged in `notification_log` for the trace.
 */

export type NotifyOn = 'ok' | 'error' | 'held' | 'throttled';

export interface ProcessNotification {
  process: ProcessRow;
  on: NotifyOn;
  batchId: string;
  runId?: string | null;
  events: readonly Event[];
  /** Extra context for the template: `run`, `batch`, `reason`. */
  context: Record<string, unknown>;
  url?: string | null;
}

const SEVERITY: Record<NotifyOn, NotificationMessage['severity']> = {
  ok: 'info',
  error: 'error',
  held: 'warning',
  throttled: 'warning',
};

export async function notifyProcess(ctx: Ctx, n: ProcessNotification): Promise<void> {
  const targets = n.process.document.notify.filter((x) => x.on.includes(n.on));
  if (targets.length === 0) return;
  const now = ctx.clock.now();
  for (const target of targets) {
    if (n.runId) {
      // Idempotent: a re-delivered finish job does not notify twice.
      const [sent] = await ctx.db
        .select({ id: notificationLog.id })
        .from(notificationLog)
        .where(
          and(
            eq(notificationLog.runId, n.runId),
            eq(notificationLog.notifierId, target.notifierId),
            eq(notificationLog.on, n.on),
          ),
        );
      if (sent) continue;
    }
    const rendered = await renderTemplate(
      ctx.engine,
      target.template,
      { process: processView(n.process), events: n.events, status: n.on, ...n.context },
      evalFunctions(ctx, n.events, now),
    );
    const title = `${n.process.name}: ${n.on}`;
    const text =
      rendered.error !== undefined ? `(template error: ${rendered.error})` : rendered.text;
    const live = ctx.runtime.notifier(target.notifierId);
    let status: 'sent' | 'error' = 'sent';
    let error: string | null = null;
    if (!live) {
      status = 'error';
      error = ctx.runtime.instanceError(target.notifierId) ?? 'notifier unavailable';
    } else {
      try {
        await live.notifier.send({
          on: n.on,
          severity: SEVERITY[n.on],
          title,
          text,
          ...(n.url ? { url: n.url } : {}),
          fields: { process: n.process.name, status: n.on },
        });
      } catch (err) {
        status = 'error';
        error = errorMessage(err);
      }
    }
    await ctx.db.insert(notificationLog).values({
      notifierId: target.notifierId,
      on: n.on,
      processId: n.process.id,
      batchId: n.batchId,
      runId: n.runId ?? null,
      title,
      text: text.slice(0, 4000),
      status,
      error,
      at: now,
    });
  }
}

export interface SystemAlert {
  /** What the alert is about; alerts with the same key are sent at most once per window. */
  key: string;
  title: string;
  text: string;
  severity?: NotificationMessage['severity'];
  rateLimitMinutes?: number;
}

/**
 * Send a system alert (breaker opened, plugin load failure, meter ceiling crossed, silent source,
 * failed callback verification) to `GlobalSettings.systemNotifierId`. Never throws.
 */
export async function sendSystemAlert(ctx: Ctx, alert: SystemAlert): Promise<boolean> {
  try {
    const now = ctx.clock.now();
    const window = (alert.rateLimitMinutes ?? 60) * 60_000;
    ctx.log.warn({ alert: alert.key, title: alert.title }, 'system alert');
    const due = await withTx(ctx.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(systemAlerts)
        .where(eq(systemAlerts.key, alert.key))
        .for('update');
      if (row && now.getTime() - row.lastSentAt.getTime() < window) {
        await tx
          .update(systemAlerts)
          .set({ count: row.count + 1 })
          .where(eq(systemAlerts.key, alert.key));
        return false;
      }
      await tx
        .insert(systemAlerts)
        .values({ key: alert.key, lastSentAt: now, count: 1 })
        .onConflictDoUpdate({ target: systemAlerts.key, set: { lastSentAt: now, count: 1 } });
      return true;
    });
    if (!due) return false;
    const settings = await getSettings(ctx.db);
    const notifierId = settings.systemNotifierId;
    if (notifierId === null) return false;
    const live = ctx.runtime.notifier(notifierId);
    let status: 'sent' | 'error' = 'sent';
    let error: string | null = null;
    if (!live) {
      status = 'error';
      error = 'system notifier unavailable';
    } else {
      try {
        await live.notifier.send({
          on: 'system',
          severity: alert.severity ?? 'warning',
          title: alert.title,
          text: alert.text,
          fields: { alert: alert.key },
        });
      } catch (err) {
        status = 'error';
        error = errorMessage(err);
      }
    }
    await ctx.db.insert(notificationLog).values({
      notifierId,
      on: 'system',
      title: alert.title,
      text: alert.text.slice(0, 4000),
      status,
      error,
      at: now,
    });
    return status === 'sent';
  } catch (err) {
    ctx.log.error({ err, alert: alert.key }, 'system alert failed');
    return false;
  }
}
