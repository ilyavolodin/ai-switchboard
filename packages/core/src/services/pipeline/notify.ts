import { eq } from 'drizzle-orm';

import type { Event, NotificationMessage } from '@ai-switchboard/sdk';

import { notificationLog, systemAlerts } from '../../db/schema.js';
import { renderTemplate } from '../../expr/index.js';
import { getSettings } from '../settings.js';

import {
  callPlugin,
  evalFunctions,
  processView,
  withTx,
  type Ctx,
  type ProcessRow,
} from './context.js';

/** Every send is logged in `notification_log` for the trace. */

export type NotifyOn = 'ok' | 'error' | 'held' | 'throttled';

export interface ProcessNotification {
  process: ProcessRow;
  on: NotifyOn;
  batchId: string;
  runId?: string | null;
  events: readonly Event[];
  /** Template context: `run`, `batch`, `reason`. */
  context: Record<string, unknown>;
  url?: string | null;
}

const SEVERITY: Record<NotifyOn, NotificationMessage['severity']> = {
  ok: 'info',
  error: 'error',
  held: 'warning',
  throttled: 'warning',
};

export function notifyProcess(ctx: Ctx, n: ProcessNotification): Promise<void> {
  if (!n.process.document.notify.some((x) => x.on.includes(n.on))) return Promise.resolve();
  return ctx.telemetry.span(
    'switchboard.notify',
    {
      process_id: n.process.id,
      batch_id: n.batchId,
      run_id: n.runId ?? undefined,
      'switchboard.notify.on': n.on,
    },
    () => notifyProcessInSpan(ctx, n),
  );
}

async function notifyProcessInSpan(ctx: Ctx, n: ProcessNotification): Promise<void> {
  const targets = n.process.document.notify.filter((x) => x.on.includes(n.on));
  if (targets.length === 0) return;
  const now = ctx.clock.now();
  const title = `${n.process.name}: ${n.on}`;
  for (const target of targets) {
    const base = {
      notifierId: target.notifierId,
      on: n.on,
      processId: n.process.id,
      batchId: n.batchId,
      runId: n.runId ?? null,
      title,
      at: now,
    };
    // A run's notification is claimed (unique per run, notifier and outcome) before anything
    // else, so a re-delivered finish job never renders or sends it twice. A crash between the
    // claim and the send leaves it `sending`: at most once, never twice.
    let claimedId: number | null = null;
    if (n.runId) {
      const [claimed] = await ctx.db
        .insert(notificationLog)
        .values({ ...base, text: '', status: 'sending', error: null })
        .onConflictDoNothing()
        .returning({ id: notificationLog.id });
      if (!claimed) continue;
      claimedId = claimed.id;
    }
    const rendered = await renderTemplate(
      ctx.engine,
      target.template,
      { process: processView(n.process), events: n.events, status: n.on, ...n.context },
      evalFunctions(ctx, n.events, now),
    );
    const text =
      rendered.error !== undefined ? `(template error: ${rendered.error})` : rendered.text;
    const { status, error } = await send(
      ctx,
      target.notifierId,
      {
        on: n.on,
        severity: SEVERITY[n.on],
        title,
        text,
        ...(n.url ? { url: n.url } : {}),
        fields: { process: n.process.name, status: n.on },
      },
      ctx.runtime.instanceError(target.notifierId) ?? 'notifier unavailable',
    );
    const outcome = { text: text.slice(0, 4000), status, error };
    if (claimedId !== null) {
      await ctx.db.update(notificationLog).set(outcome).where(eq(notificationLog.id, claimedId));
    } else {
      await ctx.db.insert(notificationLog).values({ ...base, ...outcome });
    }
  }
}

async function send(
  ctx: Ctx,
  notifierId: string,
  message: NotificationMessage,
  unavailable: string,
): Promise<{ status: 'sent' | 'error'; error: string | null }> {
  const live = ctx.runtime.notifier(notifierId);
  if (!live) return { status: 'error', error: unavailable };
  const notifier = live.notifier;
  const plugin = ctx.runtime.notifierType(live.typeId)?.pluginName ?? live.typeId;
  const out = await callPlugin(ctx, plugin, 'send', () => notifier.send(message));
  return out.ok ? { status: 'sent', error: null } : { status: 'error', error: out.error };
}

export interface SystemAlert {
  /** What the alert is about; alerts with the same key are sent at most once per window. */
  key: string;
  title: string;
  text: string;
  severity?: NotificationMessage['severity'];
  rateLimitMinutes?: number;
}

/** Sends to `GlobalSettings.systemNotifierId`. Never throws. */
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
    const { status, error } = await send(
      ctx,
      notifierId,
      {
        on: 'system',
        severity: alert.severity ?? 'warning',
        title: alert.title,
        text: alert.text,
        fields: { alert: alert.key },
      },
      'system notifier unavailable',
    );
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
