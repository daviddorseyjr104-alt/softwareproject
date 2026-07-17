// Cross-platform launcher for DEMO mode (sets env, then boots the server with fake providers).
//   npm run demo
//
// DEMO swaps in fake providers: no API keys, no network calls, no email, no spend. Boot safety
// otherwise refuses to start without ADMIN_PASSWORD/SECRET_KEY (it fails closed, so that a host
// which merely forgets to set NODE_ENV doesn't come up wide open). This is the one context where
// running open is the point, so opt in explicitly rather than weakening the check for everyone.
process.env.DEMO = 'true';
process.env.ALLOW_INSECURE_DEV = '1';
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'development';
if (!process.env.WEBHOOK_SECRET) process.env.WEBHOOK_SECRET = 'demo-secret';
if (!process.env.PORT) process.env.PORT = '3999';
await import('../src/server.js');
