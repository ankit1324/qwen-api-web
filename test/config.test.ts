import { describe, it, expect } from 'vitest';
import { getConfig, parseConfig } from '../src/config';

describe('Configuration', () => {
  it('parses minimal valid config', () => {
    const config = parseConfig({ port: 8082, token: "qwen-jwt", api_keys: [] });
    expect(config.port).toBe(8082);
    expect(config.token).toBe("qwen-jwt");
  });
});
