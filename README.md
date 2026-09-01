# qwen-api-web

A local proxy that exposes [chat.qwen.ai](https://chat.qwen.ai) as an OpenAI-compatible API. Run it locally, point any OpenAI-SDK-compatible client (Codex CLI, curl, etc.) at `http://localhost:8081/v1`, and use Qwen models without an API billing account.

## Features

- `GET /v1/models` — model list (falls back to guest models if no token set)
- `POST /v1/chat/completions` — Chat Completions API, streaming and non-streaming
- `POST /v1/responses` — Responses API (for Codex CLI), with tool-call bridging
- Optional Bearer-key auth for your own clients
- Tokenless guest mode fallback when no Qwen token is configured

## Requirements

- Node.js 20+
- Chrome / Chromium / Edge installed (used to generate baxia anti-bot tokens via CDP)
  - macOS: Google Chrome is picked up automatically from `/Applications`
  - Linux: set `CHROME_PATH=/usr/bin/chromium` (or use the Docker image, which bundles it)

## Setup

```bash
git clone <this repo>
cd qwen-api-web
npm install
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "port": 8081,
  "token": "YOUR_QWEN_LOCALSTORAGE_TOKEN_HERE",
  "api_keys": []
}
```

| Field | Description |
|---|---|
| `port` | Port to serve on (default `8081`) |
| `token` | Optional. Your Qwen web token — gives access to your account's models. Without it, requests run in guest mode. |
| `api_keys` | Optional. If non-empty, clients must send `Authorization: Bearer <key>` with one of these values. Leave empty to disable auth. |

### Getting your Qwen token

1. Log in to [chat.qwen.ai](https://chat.qwen.ai) in your browser
2. Open DevTools → Application → Local Storage → `https://chat.qwen.ai`
3. Copy the value of the `token` key into `config.json`

Environment overrides: `QWEN_TOKEN` and `PORT` take precedence over `config.json`.

## Run

```bash
npm start        # dev (tsx, no build needed)
# or production:
npm run build && npm run serve
```

## Docker

```bash
docker build -t qwen-api-web .
docker run -p 8081:8081 -v "$PWD/config.json:/app/config.json" qwen-api-web
```

The image includes Chromium, so baxia token generation works out of the box.

## Usage

### curl

```bash
curl http://localhost:8081/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-api-key-if-configured>" \
  -d '{
    "model": "qwen3.7-plus",
    "messages": [{ "role": "user", "content": "Hello" }],
    "stream": false
  }'
```

List models:

```bash
curl http://localhost:8081/v1/models
```

### Codex CLI

Use the bundled launcher, which auto-starts the proxy if it is not running:

```bash
./codex-qwen                      # default model (qwen3.8-max)
./codex-qwen -m qwen3.7-plus      # pick a model
./codex-qwen --list-models        # show available models
```

If you configured `api_keys`, set `QWEN_API_KEY` first (the Codex provider reads it from that env var):

```bash
export QWEN_API_KEY=<your-api-key>
```

See `codex.config.toml` for the equivalent raw Codex config, and `codex.dashscope.toml` if you want to use Alibaba DashScope directly instead of this proxy.

### OpenAI SDK (any language)

Point the base URL at the proxy:

```js
const client = new OpenAI({ baseURL: "http://localhost:8081/v1", apiKey: "anything" });
```

## Testing

```bash
npm test
```

## Troubleshooting

- **"Upstream risk control" errors** — Qwen's anti-bot system throttled the request. The proxy retries automatically with fresh baxia tokens; if it persists, make sure Chrome is installed and up to date.
- **Proxy starts but all requests fail** — verify your `token` in `config.json` is current (log out/in on chat.qwen.ai refreshes it). Without a token it falls back to guest mode, which has model limits.
- **Port already in use** — change `port` in `config.json` or run with `PORT=8082 npm start`.
