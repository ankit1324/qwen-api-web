import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import modelsRouter from './routes/models';
import chatRouter from './routes/chat';
import { getConfig } from './config';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors());
app.route('/', modelsRouter);
app.route('/', chatRouter);

export function startServer() {
  const config = getConfig();
  console.log(`Starting Qwen API Proxy on port ${config.port}`);
  serve({
    fetch: app.fetch,
    port: config.port
  });
}

export default app;
