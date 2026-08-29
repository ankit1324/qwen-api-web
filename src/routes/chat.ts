import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getConfig } from '../config';
import { generateCompletion } from '../qwen/client';

const chat = new Hono();

// Auth Middleware
chat.use('/v1/*', async (c, next) => {
  const config = getConfig();
  if (config.api_keys && config.api_keys.length > 0) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: { message: "Unauthorized" } }, 401);
    }
    const token = authHeader.replace('Bearer ', '').trim();
    if (!config.api_keys.includes(token)) {
      return c.json({ error: { message: "Invalid API key" } }, 401);
    }
  }
  await next();
});

chat.post('/v1/chat/completions', async (c) => {
  const config = getConfig();
  const body = await c.req.json();
  const { model = 'qwen3.7-plus', messages, stream = false } = body;

  try {
    const qwenRes = await generateCompletion(model, messages, stream, config.token);

    if (!stream) {
      const data = await qwenRes.json();
      return c.json(data);
    } 
    
    // Pass-through SSE
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    return c.body(qwenRes.body);

  } catch (error: any) {
    return c.json({ error: { message: error.message || 'Unknown error' } }, 500);
  }
});

export default chat;
