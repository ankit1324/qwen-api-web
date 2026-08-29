# qwen-web2api Spec

**Goal:** Convert chat.qwen.ai into a local OpenAI-compatible API for use with tools like ChatBox, Cherry Studio, and the OpenAI SDK.

**Architecture:** 
- Node.js local process built on Hono/TypeScript.
- Single unified entry point wrapping Qwen's undocumented backend API.
- Converts `/v1/chat/completions` requests to Qwen requests using user cookies from a file/env.
- Streams responses back as standard OpenAI Server-Sent Events (SSE).

**Design:**

1. **Configuration:**
   - Reads `config.json` containing `port`, `cookie` (the Qwen JWT token from localStorage), and `api_keys` for proxy access control.
   - CLI flags can override JSON configuration.

2. **Routes:**
   - `GET /v1/models` -> Static map of available models (`qwen3.7-plus`, `qwen3.8-max`).
   - `POST /v1/chat/completions` -> The core proxy endpoint.

3. **Core Proxy Logic:**
   - Validates incoming `Authorization: Bearer <key>` against configured `api_keys` (if any are set).
   - Translates OpenAI `messages` into Qwen's backend format. Since we're doing stateless, we send the aggregated messages forward.
   - Makes streaming HTTP request to `chat.qwen.ai`.
   - Reads backend chunk stream, unpacks Qwen JSON, transposes to OpenAI chunk `{"choices":[{"delta":{"content":"..."}}]}`.

**Constraints:**
- No Qwen conversation history tracking (stateless).
- No multimodal images or tool calling for v1.
- No heavy server frameworks like Fastify, just minimal Hono.
