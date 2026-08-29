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
