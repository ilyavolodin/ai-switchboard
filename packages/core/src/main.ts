#!/usr/bin/env node
import { createSwitchboard } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger({ level: config.logLevel, pretty: config.prettyLogs });

try {
  const switchboard = await createSwitchboard({
    config,
    logger,
    ...(process.env.SWITCHBOARD_ADMIN_PASSWORD
      ? { adminPassword: process.env.SWITCHBOARD_ADMIN_PASSWORD }
      : {}),
  });
  await switchboard.start();
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    switchboard.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} catch (err) {
  logger.fatal({ err }, 'switchboard failed to start');
  process.exit(1);
}
