import type { Server } from 'node:http';

/** Types for `server.js`, so TypeScript tests can import the stub. */

export interface StubConfig {
  callbackSecret: string;
  routines429: boolean;
  routines429Every: number;
  retryAfterSeconds: number;
  fiveHour: number;
  sevenDay: number;
}

export interface StubServerOptions extends Partial<StubConfig> {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  now?: () => Date;
}

export interface RecordedStubRequest {
  at: string;
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface OutboundStubCall {
  at: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  error?: string;
}

export interface StubServer {
  server: Server;
  config: StubConfig;
  requests: RecordedStubRequest[];
  outbound: OutboundStubCall[];
  settled(): Promise<unknown>;
  listen(port?: number, host?: string): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

export function sign(secret: string, body: string | Buffer): string;
export function createStubServer(options?: StubServerOptions): StubServer;
