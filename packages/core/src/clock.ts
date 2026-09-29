export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string = '2026-01-05T09:00:00Z') {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  set(to: Date | string): void {
    this.current = new Date(to).getTime();
  }

  advance(ms: number): Date {
    this.current += ms;
    return this.now();
  }

  advanceSeconds(s: number): Date {
    return this.advance(s * 1000);
  }

  advanceMinutes(m: number): Date {
    return this.advance(m * 60_000);
  }
}
