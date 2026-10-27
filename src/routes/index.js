// ============================================================================
// ROUTE REGISTRATION
// Every endpoint is namespaced under /api. Unknown /api paths return JSON 404
// (see app.js); unknown page paths fall back to the SPA shell.
// ============================================================================
import { registerAuthRoutes } from './auth-routes.js';
import { registerPublicRoutes } from './public-routes.js';
import { registerOrderRoutes } from './order-routes.js';
import { registerWalletRoutes } from './wallet-routes.js';
import { registerAdminRoutes } from './admin-routes.js';
import { registerWebhookRoutes } from './webhook-routes.js';
import { registerPaymentWebhookRoutes } from './payment-webhook-routes.js';
import { registerCronRoutes } from './cron-routes.js';
import { registerNotificationRoutes } from './notification-routes.js';

export function registerRoutes({ router, services, config, logger }) {
  registerPublicRoutes({ router, services });
  registerAuthRoutes({ router, services });
  registerOrderRoutes({ router, services });
  registerWalletRoutes({ router, services });
  registerNotificationRoutes({ router, services });
  registerAdminRoutes({ router, services });
  registerWebhookRoutes({ router, config, logger });
  registerPaymentWebhookRoutes({ router, services, logger });
  registerCronRoutes({ router, services, config, logger });
  return router;
}
