import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../src/server';
import * as client from '../src/qwen/client';
import * as config from '../src/config';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /v1/chat/completions', () => {
  it('handles non-streaming chat', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      new Response(JSON.stringify({
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1732711466,
        model: "qwen3.7-plus",
        choices: [{ index: 0, message: { role: "assistant", content: "hello world" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }), { headers: { 'Content-Type': 'application/json' } })
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
    expect(body.usage.prompt_tokens).toBe(5);
  });

  it('rejects unauthorized requests when api_keys is set', async () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({
      port: 8081,
      token: 'fake-token',
      api_keys: ['test-key']
    });

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-plus',
        messages: [{ role: 'user', content: 'test' }]
      })
    });

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.message).toBe('Unauthorized');
  });

  it('streams SSE response when stream is true', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1732711466,"model":"qwen3.7-plus","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    });
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
    );

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.7-plus',
        messages: [{ role: 'user', content: 'test' }],
        stream: true
      })
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data:');
    expect(text).toContain('hi');
    expect(text).toContain('[DONE]');
  });
});