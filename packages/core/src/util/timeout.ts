export class TimeoutError extends Error {
  override readonly name = 'TimeoutError';
}

export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof Error && err.name === 'TimeoutError';
}

/** Rejects with a `TimeoutError` after `ms`; the work itself keeps running and its result is ignored. */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(message));
    }, ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
