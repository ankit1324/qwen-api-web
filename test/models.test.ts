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
