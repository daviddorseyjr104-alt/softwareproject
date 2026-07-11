// Cross-platform launcher for DEMO mode (sets env, then boots the server with fake providers).
//   npm run demo
process.env.DEMO = 'true';
if (!process.env.WEBHOOK_SECRET) process.env.WEBHOOK_SECRET = 'demo-secret';
if (!process.env.PORT) process.env.PORT = '3999';
await import('../src/server.js');
