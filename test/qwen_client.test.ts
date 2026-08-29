import { describe, it, expect, vi, afterEach } from 'vitest';
import { generateCompletion } from '../src/qwen/client';
import * as baxia from '../src/qwen/baxia';

vi.mock('../src/qwen/baxia', () => ({
  getBaxiaTokens: vi.fn(),
}));

const mockGetBaxia = vi.mocked(baxia.getBaxiaTokens);
const fakeTokens = { bxUa: '234!testua', bxUmidToken: 'T2gAtest', bxV: '2.5.37', cookies: '' };

const sseBody = [
  'data: {"choices":[{"delta":{"role":"assistant","content":"Hello","phase":"streaming"}}]}',
  '',
  'data: {"choices":[{"delta":{"content":" world","phase":"streaming"}}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}',
  '',
  'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

function sseResponse(body: string): Response {
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

function createResponse(body: any): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
}

function setUpStreamFetch(): void {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(createResponse({ success: true, data: { id: 'chat-1' } }))
    .mockResolvedValueOnce(sseResponse(sseBody));
  vi.stubGlobal('fetch', fetchMock);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Qwen Client (v2 flow)', () => {
  it('creates a chat session then sends completion (non-stream)', async () => {
    mockGetBaxia.mockResolvedValue(fakeTokens);
    setUpStreamFetch();

    const res = await generateCompletion('qwen3.7-plus', [{ role: 'user', content: 'hi' }], false);

    const fetchMock = vi.mocked(global.fetch);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(createUrl).toContain('/api/v2/chats/new');
    const createBody = JSON.parse(createInit.body);
    expect(createBody.chat_mode).toBe('guest');

    const [completionUrl, completionInit] = fetchMock.mock.calls[1];
    expect(completionUrl).toContain('/api/v2/chat/completions?chat_id=chat-1');
    expect(completionInit.headers['bx-ua']).toBe(fakeTokens.bxUa);
    expect(completionInit.headers['bx-umidtoken']).toBe(fakeTokens.bxUmidToken);
    const completionBody = JSON.parse(completionInit.body);
    expect(completionBody.chat_mode).toBe('guest');
    expect(completionBody.messages[0].content).toContain('hi');

    const data = await res.json();
    expect(data.choices[0].message.content).toBe('Hello world');
    expect(data.usage.prompt_tokens).toBe(5);
  });

  it('streams OpenAI-format SSE when stream is true', async () => {
    mockGetBaxia.mockResolvedValue(fakeTokens);
    setUpStreamFetch();

    const res = await generateCompletion('qwen3.7-plus', [{ role: 'user', content: 'hi' }], true);

    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('data: {"id":"chatcmpl-');
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain('Hello');
    expect(text).toContain('data: [DONE]');
    expect(text).toContain('"finish_reason":"stop"');
  });

  it('retries with fresh tokens when upstream risk-controls', async () => {
    mockGetBaxia
      .mockResolvedValueOnce(fakeTokens)
      .mockResolvedValueOnce({ ...fakeTokens, bxUmidToken: 'T2gAfresh' });
    const punishBody = JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM'], data: { url: 'punish?action=captcha' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createResponse({ success: true, data: { id: 'chat-1' } }))
      .mockResolvedValueOnce(new Response(punishBody, { headers: { 'Content-Type': 'application/json;charset=UTF-8' } }))
      .mockResolvedValueOnce(createResponse({ success: true, data: { id: 'chat-2' } }))
      .mockResolvedValueOnce(sseResponse(sseBody));
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateCompletion('qwen3.7-plus', [{ role: 'user', content: 'hi' }], false);

    expect(mockGetBaxia).toHaveBeenCalledTimes(2);
    expect(mockGetBaxia).toHaveBeenLastCalledWith(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const data = await res.json();
    expect(data.choices[0].message.content).toBe('Hello world');
  });

  it('uses normal (JWT) mode first, falls back to guest on risk control', async () => {
    mockGetBaxia.mockResolvedValue(fakeTokens);
    const punishBody = JSON.stringify({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM'], data: { url: 'punish?action=captcha' } });
    const fetchMock = vi.fn()
      // normal mode (1 attempt): create + punished completion
      .mockResolvedValueOnce(createResponse({ success: true, data: { id: 'chat-1' } }))
      .mockResolvedValueOnce(new Response(punishBody, { headers: { 'Content-Type': 'application/json;charset=UTF-8' } }))
      // guest mode: create + ok
      .mockResolvedValueOnce(createResponse({ success: true, data: { id: 'chat-g' } }))
      .mockResolvedValueOnce(sseResponse(sseBody));
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateCompletion('qwen3.7-plus', [{ role: 'user', content: 'hi' }], false, 'jwt-token');

    const createCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/chats/new'));
    expect(createCalls.length).toBe(2);
    // first call should use normal mode + auth
    const firstCreateBody = JSON.parse(createCalls[0][1].body);
    expect(firstCreateBody.chat_mode).toBe('normal');
    expect(createCalls[0][1].headers['Authorization']).toBe('Bearer jwt-token');
    // last call should be guest mode, no auth
    const lastCreateBody = JSON.parse(createCalls[createCalls.length - 1][1].body);
    expect(lastCreateBody.chat_mode).toBe('guest');
    expect(createCalls[createCalls.length - 1][1].headers['Authorization']).toBeUndefined();

    const data = await res.json();
    expect(data.choices[0].message.content).toBe('Hello world');
  });
});