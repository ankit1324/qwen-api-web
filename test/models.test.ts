import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../src/server';
import * as config from '../src/config';

const upstreamModels = {
  data: [
    { id: 'qwen3.7-plus', name: 'Qwen3.7-Plus', object: 'model', owned_by: 'qwen' },
    { id: 'qwen3.8-max', name: 'Qwen3.8-Max', object: 'model', owned_by: 'qwen' },
    { id: 'qwen3.7-max', name: 'Qwen3.7-Max', object: 'model', owned_by: 'qwen' },
    { id: 'qwen3.6-plus', name: 'Qwen3.6-Plus', object: 'model', owned_by: 'qwen' },
    { id: 'qwen3.5-plus', name: 'Qwen3.5-Plus', object: 'model', owned_by: 'qwen' },
    { id: 'qwen3.5-omni-plus', name: 'Qwen3.5-Omni-Plus', object: 'model', owned_by: 'qwen' },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /v1/models', () => {
  it('returns all models from upstream when token is set', async () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({
      port: 8081,
      token: 'fake-jwt',
      api_keys: [],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstreamModels), { headers: { 'Content-Type': 'application/json' } })
    ));

    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('list');
    expect(body.data.length).toBe(6);
    expect(body.data[0].id).toBe('qwen3.7-plus');
    expect(body.data.map((m: any) => m.id)).toContain('qwen3.5-omni-plus');
  });

  it('falls back to guest models when no token', async () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({
      port: 8081,
      token: null,
      api_keys: [],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify(upstreamModels), { headers: { 'Content-Type': 'application/json' } })
    ));

    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(2);
    expect(body.data[0].id).toBe('qwen3.7-plus');
  });

  it('falls back to guest models when upstream fails', async () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({
      port: 8081,
      token: 'fake-jwt',
      api_keys: [],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('error', { status: 500 })
    ));

    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBe(2);
  });
});