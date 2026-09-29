import type { FastifyInstance } from 'fastify';

import type { ApiContext } from '../context.js';
import { registerApprovalRoutes } from './approvals.js';
import { registerAuthRoutes } from './auth.js';
import { registerBoardRoutes } from './board.js';
import { registerConfigRoutes } from './config.js';
import { registerDestinationRoutes } from './destinations.js';
import { registerEventRoutes } from './events.js';
import { registerNotifierRoutes } from './notifiers.js';
import { registerPluginRoutes } from './plugins.js';
import { registerProcessRoutes } from './processes.js';
import { registerRunRoutes } from './runs.js';
import { registerSecretProviderRoutes } from './secret-providers.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSourceRoutes } from './sources.js';
import { registerUserRoutes } from './users.js';

/** Every `/api/v1` route; `ApiRoutes` in the contract lists the same set. */
export function registerApiRoutes(app: FastifyInstance, ctx: ApiContext): void {
  registerAuthRoutes(app, ctx);
  registerBoardRoutes(app, ctx);
  registerSourceRoutes(app, ctx);
  registerDestinationRoutes(app, ctx);
  registerNotifierRoutes(app, ctx);
  registerSecretProviderRoutes(app, ctx);
  registerProcessRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerRunRoutes(app, ctx);
  registerApprovalRoutes(app, ctx);
  registerPluginRoutes(app, ctx);
  registerUserRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
}
