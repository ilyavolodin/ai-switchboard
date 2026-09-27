import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;

/**
 * Starts one Postgres for the integration project (or uses DATABASE_URL). Each test file then
 * creates its own database from it with `createTestDatabase()`.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let url = process.env.TEST_DATABASE_URL;
  if (url === undefined || url === '') {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('switchboard')
      .withUsername('switchboard')
      .withPassword('switchboard')
      .start();
    url = container.getConnectionUri();
  }
  project.provide('databaseUrl', url);
  return async () => {
    await container?.stop();
  };
}
