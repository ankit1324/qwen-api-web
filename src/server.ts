import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import modelsRouter from './routes/models';
import chatRouter from './routes/chat';
import responsesRouter from './routes/responses';
import { getConfig } from './config';
import { cors } from 'hono/cors';
import { logHttp } from './logger';

const app = new Hono();

app.use('*', cors());

app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  logHttp(c.req.method, c.req.path, c.res?.status ?? 0, Date.now() - started);
});

app.route('/', modelsRouter);
app.route('/', chatRouter);
app.route('/', responsesRouter);

export function startServer() {
  const config = getConfig();
  console.log(`Starting Qwen API Proxy on port ${config.port}`);
  serve({
    fetch: app.fetch,
    port: config.port
  });
}

export default app;
