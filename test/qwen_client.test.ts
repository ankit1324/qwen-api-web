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

  it('throws with Upstream error on non-ok response', async () => {
    const mockFetch = vi.mocked(global.fetch);
    mockFetch.mockResolvedValueOnce(new Response("bad request", { status: 400 }));

    await expect(
      generateCompletion("qwen3.7-plus", [{ role: "user", content: "hey" }], false, "fake-token")
    ).rejects.toThrow(/Upstream error/);
  });
});
