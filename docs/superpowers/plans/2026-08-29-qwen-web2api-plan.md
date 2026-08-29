# Qwen Web to API Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js Hono proxy that converts `chat.qwen.ai` into a local OpenAI-compatible API.

**Architecture:** A fast Node server using Hono for routing, returning standard OpenAI JSON or SSE chunks. Requests to Qwen use `fetch` with the provided JWT bearer token.

**Tech Stack:** TypeScript, Node.js (v18+), Hono (@hono/node-server), Vitest (for testing).

## Global Constraints

- Stateless: do not store Qwen chat session IDs.
- Core OpenAI proxy only: no image parsing or tool calling in v1.
- Pure Node `fetch` used for network requests.

---

### Task 1: Project Setup and Config Loading

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/config.ts`
- Create: `config.example.json`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `getConfig(): Config` which returns the merged config from JSON and ENV.

- [ ] **Step 1: Scaffolding package.json and tsconfig**
```bash
npm init -y
npm install hono @hono/node-server
npm install -D typescript @types/node vitest tsx
npx tsc --init
```
Update `tsconfig.json` to have `"outDir": "./dist"` and `"moduleResolution": "node"`.

- [ ] **Step 2: Write failing test for config loader**
```typescript
// test/config.test.ts
import { describe, it, expect } from 'vitest';
import { getConfig, parseConfig } from '../src/config';

describe('Configuration', () => {
  it('parses minimal valid config', () => {
    const config = parseConfig({ port: 8082, token: "qwen-jwt", api_keys: [] });
    expect(config.port).toBe(8082);
    expect(config.token).toBe("qwen-jwt");
  });
});
```

- [ ] **Step 3: Run test**
Run: `npx vitest run test/config.test.ts`
Expected: FAIL, module not found

- [ ] **Step 4: Implement configuration loader**
```typescript
// src/config.ts
import * as fs from 'fs';
import * as path from 'path';

export interface Config {
  port: number;
  token: string | null;
  api_keys: string[];
}

export const DEFAULT_CONFIG: Config = {
  port: 8081,
  token: null,
  api_keys: [],
};

export function parseConfig(data: Partial<Config>): Config {
  return { ...DEFAULT_CONFIG, ...data };
}

export function getConfig(): Config {
  let jsonConfig: Partial<Config> = {};
  const configPath = path.resolve(process.cwd(), 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      jsonConfig = JSON.parse(content);
    } catch (e) {
      console.warn('Failed to parse config.json, using defaults.');
    }
  }
  
  const token = process.env.QWEN_TOKEN || jsonConfig.token || null;
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : (jsonConfig.port || DEFAULT_CONFIG.port);
  const api_keys = jsonConfig.api_keys || DEFAULT_CONFIG.api_keys;

  return { port, token, api_keys };
}
```

```json
// config.example.json
{
  "port": 8081,
  "token": "YOUR_QWEN_LOCALSTORAGE_TOKEN_HERE",
  "api_keys": []
}
```

- [ ] **Step 5: Run test**
Run: `npx vitest run test/config.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**
```bash
git add package.json package-lock.json tsconfig.json src/config.ts test/config.test.ts config.example.json
git commit -m "chore: setup project and config loader"
```

---

### Task 2: Models Endpoint and App Server

**Files:**
- Create: `src/server.ts`
- Create: `src/routes/models.ts`
- Test: `test/models.test.ts`

**Interfaces:**
- Consumes: `getConfig`
- Produces: Default export `app` (Hono app instance)

- [ ] **Step 1: Write failing test**
```typescript
// test/models.test.ts
import { describe, it, expect } from 'vitest';
import app from '../src/server';

describe('GET /v1/models', () => {
  it('returns available models in openai format', async () => {
    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBeGreaterThan(0);
    expect(body.data[0].id).toBe('qwen3.7-plus');
  });
});
```

- [ ] **Step 2: Run test**
Run: `npx vitest run test/models.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement models endpoint & server**
```typescript
// src/routes/models.ts
import { Hono } from 'hono';

const models = new Hono();

export const AVAILABLE_MODELS = [
  {
    id: "qwen3.7-plus",
    object: "model",
    created: 1732711466,
    owned_by: "qwen"
  },
  {
    id: "qwen3.8-max",
    object: "model",
    created: 1732711466,
    owned_by: "qwen"
  }
];

models.get('/v1/models', (c) => {
  return c.json({
    object: "list",
    data: AVAILABLE_MODELS
  });
});

export default models;
```

```typescript
// src/server.ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import modelsRouter from './routes/models';
import { getConfig } from './config';
import { cors } from 'hono/cors';

const app = new Hono();

app.use('*', cors());
app.route('/', modelsRouter);

export function startServer() {
  const config = getConfig();
  console.log(`Starting Qwen API Proxy on port ${config.port}`);
  serve({
    fetch: app.fetch,
    port: config.port
  });
}

export default app;
```

- [ ] **Step 4: Run test**
Run: `npx vitest run test/models.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/server.ts src/routes/models.ts test/models.test.ts
git commit -m "feat: GET /v1/models implementation"
```

---

### Task 3: Qwen Client Proxy Layer

**Files:**
- Create: `src/qwen/client.ts`
- Test: `test/qwen_client.test.ts`

**Interfaces:**
- Consumes: `getConfig`
- Produces: `async function generateCompletion(model: string, messages: any[], stream: boolean): Promise<Response>`

- [ ] **Step 1: Write failing test**
```typescript
// test/qwen_client.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generateCompletion } from '../src/qwen/client';

global.fetch = vi.fn();

describe('Qwen Client', () => {
  it('formats request properly', async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValueOnce(new Response("ok"));

    await generateCompletion("qwen3.7-plus", [{role: "user", content: "hey"}], false, "fake-token");
    
    expect(mockFetch).toHaveBeenCalled();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://chat.qwen.ai/api/chat/completions");
    expect(init?.headers).toMatchObject({
      "Authorization": "Bearer fake-token",
      "Content-Type": "application/json"
    });
    
    const body = JSON.parse(init?.body as string);
    expect(body.model).toBe("qwen3.7-plus");
    expect(body.messages[0].content).toBe("hey");
  });
});
```

- [ ] **Step 2: Run test**
Run: `npx vitest run test/qwen_client.test.ts`
Expected: FAIL, module not found

- [ ] **Step 3: Implement Qwen Client**
```typescript
// src/qwen/client.ts
export async function generateCompletion(model: string, messages: any[], stream: boolean, token: string | null): Promise<Response> {
  if (!token) {
    throw new Error('Qwen token is not configured.');
  }

  const payload = {
    model,
    messages,
    stream
  };

  const response = await fetch('https://chat.qwen.ai/api/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Upstream error: ${response.status} - ${err}`);
  }

  return response;
}
```

- [ ] **Step 4: Run test**
Run: `npx vitest run test/qwen_client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/qwen/client.ts test/qwen_client.test.ts
git commit -m "feat: Qwen upstream fetch implementation"
```

---

### Task 4: API Auth and Chat Completions Route (Non-Streaming)

**Files:**
- Create: `src/routes/chat.ts`
- Modify: `src/server.ts`
- Test: `test/chat.test.ts`

**Interfaces:**
- Consumes: `generateCompletion`, `getConfig`
- Produces: `POST /v1/chat/completions`

- [ ] **Step 1: Write failing test**
```typescript
// test/chat.test.ts
import { describe, it, expect, vi } from 'vitest';
import app from '../src/server';
import * as client from '../src/qwen/client';

describe('POST /v1/chat/completions', () => {
  it('handles non-streaming chat', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: "chatcmpl-123",
        choices: [{ message: { content: "hello world" } }]
      }))
    );

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-plus',
        messages: [{ role: 'user', content: 'test' }]
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].message.content).toBe('hello world');
  });
});
```

- [ ] **Step 2: Run test**
Run: `npx vitest run test/chat.test.ts`
Expected: FAIL (404)

- [ ] **Step 3: Implement Chat Route**
```typescript
// src/routes/chat.ts
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
```

Modify `src/server.ts` to hook it up:
```typescript
// src/server.ts (append to imports)
import chatRouter from './routes/chat';

// src/server.ts (append after modelsRouter)
app.route('/', chatRouter);
```

- [ ] **Step 4: Run test**
Run: `npx vitest run test/chat.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/routes/chat.ts src/server.ts test/chat.test.ts
git commit -m "feat: complete POST /v1/chat/completions auth and handling"
```

---

### Task 5: App Entrypoint & Docker Support

**Files:**
- Create: `src/index.ts`
- Create: `Dockerfile`

**Interfaces:**
- Consumes: `startServer`

- [ ] **Step 1: Write entrypoint script**
```typescript
// src/index.ts
import { startServer } from './server';

// Handle unhandled rejections to prevent crashing the whole proxy silently
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

startServer();
```

- [ ] **Step 2: Add start script to package.json**
Add this to `package.json` under `"scripts"`:
```json
"start": "tsx src/index.ts",
"build": "tsc",
"serve": "node dist/index.js"
```

- [ ] **Step 3: Create Dockerfile**
```dockerfile
# Dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 8081

CMD ["npm", "run", "serve"]
```

- [ ] **Step 4: Commit**
```bash
git add src/index.ts Dockerfile package.json
git commit -m "chore: add entrypoint and Dockerfile"
```
