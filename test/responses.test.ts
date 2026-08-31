import { describe, it, expect, vi, afterEach } from 'vitest';
import app from '../src/server';
import * as client from '../src/qwen/client';
import * as config from '../src/config';

afterEach(() => {
  vi.restoreAllMocks();
});

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    }
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
}

function jsonCompletion(content: string, usage?: any): Response {
  return new Response(JSON.stringify({
    id: 'chatcmpl-123',
    object: 'chat.completion',
    created: 1732711466,
    model: 'qwen3.8-max',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: usage || { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  }), { headers: { 'Content-Type': 'application/json' } });
}

function completionChunk(delta: string, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1732711466, model: 'qwen3.8-max', choices: [{ index: 0, delta: { content: delta }, finish_reason: finish }] })}\n\n`;
}

function readSse(text: string): any[] {
  return text.split('\n\n').filter(Boolean).map(block => {
    const line = block.split('\n').find(l => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }).filter(Boolean);
}

describe('POST /v1/responses', () => {
  it('handles non-streaming response with plain text', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(jsonCompletion('hello world'));

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.8-max',
        input: [{ type: 'message', role: 'user', content: 'test' }],
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.output[0].type).toBe('message');
    expect(body.output[0].content[0].text).toBe('hello world');
    expect(body.usage.input_tokens).toBe(5);
  });

  it('accepts string input shorthand', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(jsonCompletion('ok'));

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output[0].content[0].text).toBe('ok');
  });

  it('returns 400 for empty prompt', async () => {
    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: [] })
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toBe('No user prompt found in input');
  });

  it('rejects unauthorized requests when api_keys is set', async () => {
    vi.spyOn(config, 'getConfig').mockReturnValue({
      port: 8081,
      token: 'fake-token',
      api_keys: ['test-key']
    });

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error.message).toBe('Unauthorized');
  });

  it('extracts tool call from [TOOL_CALL] block (non-streaming)', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion('[TOOL_CALL]\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n[/TOOL_CALL]')
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.8-max',
        input: [{ type: 'message', role: 'user', content: 'weather in tokyo?' }],
        tools: [{ type: 'function', name: 'get_weather', description: 'get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }],
      })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe('function_call');
    expect(body.output[0].name).toBe('get_weather');
    expect(body.output[0].call_id).toMatch(/^call_/);
    expect(body.output[0].arguments).toBe('{"city":"Tokyo"}');
  });

  it('keeps leading text and tool call in output (non-streaming)', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion('Let me check.[TOOL_CALL]\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n[/TOOL_CALL]')
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output).toHaveLength(2);
    expect(body.output[0].type).toBe('message');
    expect(body.output[0].content[0].text).toBe('Let me check.');
    expect(body.output[1].type).toBe('function_call');
  });

  it('emits malformed tool block as literal text', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion('[TOOL_CALL]\nnot json\n[/TOOL_CALL]')
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output[0].type).toBe('message');
    expect(body.output[0].content[0].text).toContain('[TOOL_CALL]\nnot json\n[/TOOL_CALL]');
  });

  it('streams SSE with output_text deltas and completed event', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      sseResponse([
        completionChunk('hel'),
        completionChunk('lo'),
        completionChunk('', 'stop'),
        'data: [DONE]\n\n',
      ])
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test', stream: true })
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const text = await res.text();
    const events = readSse(text);
    const types = events.map(e => e.type);
    expect(types).toContain('response.created');
    expect(types).toContain('response.output_text.delta');
    expect(types).toContain('response.output_item.done');
    expect(types[types.length - 1]).toBe('response.completed');

    const deltas = events.filter(e => e.type === 'response.output_text.delta');
    expect(deltas.map(d => d.text).join('')).toBe('hello');

    const completed = events.find(e => e.type === 'response.completed');
    expect(completed.response.output[0].content[0].text).toBe('hello');
  });

  it('streams tool calls as function_call events', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      sseResponse([
        completionChunk('[TOOL_C'),
        completionChunk('ALL]\n{"name": "get_weather", "arg'),
        completionChunk('uments": {"city": "Tokyo"}}\n[/TOOL_CALL]'),
        completionChunk('', 'stop'),
        'data: [DONE]\n\n',
      ])
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test', stream: true })
    });

    expect(res.status).toBe(200);
    const events = readSse(await res.text());
    const types = events.map(e => e.type);
    expect(types).toContain('response.function_call_arguments.delta');
    expect(types).toContain('response.function_call_arguments.done');

    const itemDone = events.find(e => e.type === 'response.output_item.done');
    expect(itemDone.item.type).toBe('function_call');
    expect(itemDone.item.name).toBe('get_weather');
    expect(itemDone.item.arguments).toBe('{"city":"Tokyo"}');

    const completed = events.find(e => e.type === 'response.completed');
    expect(completed.response.output).toHaveLength(1);
    expect(completed.response.output[0].type).toBe('function_call');
  });

  it('does not leak [TOOL_CALL] markers into streamed text', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      sseResponse([
        completionChunk('Checking[TOOL_CALL]{"name": "f", "argu'),
        completionChunk('ments": {}}[/TOOL_CALL]done'),
        completionChunk('', 'stop'),
        'data: [DONE]\n\n',
      ])
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test', stream: true })
    });

    const events = readSse(await res.text());
    const deltas = events.filter(e => e.type === 'response.output_text.delta');
    expect(deltas.map(d => d.text).join('')).toBe('Checkingdone');
  });

  it('drops a bracket-less [TOOL_CALLS drift attempt without leaking it, keeps trailing prose', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion('[TOOL_CALLS\nupdate_plan\n</think>\n\nPlan created. Now I\'ll build each file.')
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe('message');
    expect(body.output[0].content[0].text).not.toContain('TOOL_CALLS');
    expect(body.output[0].content[0].text).toContain("Plan created. Now I'll build each file.");
  });

  it('recovers a real call from a bracket-less [TOOL_CALLS drift with a bare name + JSON args', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion('[TOOL_CALLS\nget_weather\n{"city": "Tokyo"}\n\ndone')
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const call = body.output.find((o: any) => o.type === 'function_call');
    expect(call.name).toBe('get_weather');
    expect(call.arguments).toBe('{"city":"Tokyo"}');
    const msg = body.output.find((o: any) => o.type === 'message');
    expect(msg.content[0].text).toBe('done');
  });

  it('recognizes a bracketed [TOOL_CALLS] plural variant like a normal tool call', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion('[TOOL_CALLS]\n{"name": "get_weather", "arguments": {"city": "Tokyo"}}\n[/TOOL_CALLS]')
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.output[0].type).toBe('function_call');
    expect(body.output[0].name).toBe('get_weather');
  });

  it('recovers a call from bracket-less [TOOL_CALLS open with a proper [/TOOL_CALL] close', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion('Now I\'ll create the pages.\n\n[TOOL_CALLS\n{"name": "update_plan", "arguments": {"plan": [{"step": "Create CSS", "status": "completed"}]}}\n[/TOOL_CALL]')
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const call = body.output.find((o: any) => o.type === 'function_call');
    expect(call).toBeDefined();
    expect(call.name).toBe('update_plan');
    expect(JSON.parse(call.arguments).plan[0].step).toBe('Create CSS');
  });

  it('recovers a call from bracket-less open with no newline before the JSON', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion('[TOOL_CALLS{"name": "exec_command", "arguments": {"cmd": "ls -la"}}\n[/TOOL_CALL]')
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const call = body.output.find((o: any) => o.type === 'function_call');
    expect(call.name).toBe('exec_command');
    expect(call.arguments).toBe('{"cmd":"ls -la"}');
  });

  it('recovers back-to-back bracket-less calls in one response', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      jsonCompletion(
        '[TOOL_CALLS{"name": "a", "arguments": {"x": 1}}\n[/TOOL_CALL]\n' +
        '[TOOL_CALLS{"name": "b", "arguments": {"y": 2}}\n[/TOOL_CALL]'
      )
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    const calls = body.output.filter((o: any) => o.type === 'function_call');
    expect(calls.map((c: any) => c.name)).toEqual(['a', 'b']);
  });

  it('handles a stream chunk boundary falling between [TOOL_CALL and its closing bracket', async () => {
    // Regression: the bare-open matcher also matches the prefix of a well-formed
    // "[TOOL_CALL]", so a split at exactly this byte used to strand the "]" and
    // corrupt an otherwise valid call.
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      sseResponse([
        completionChunk('I will make a plan.\n\n[TOOL_CALL'),
        completionChunk(']\n{"name": "update_plan", "arguments": {"plan": ["a"]}}\n[/TOOL_CALL]'),
        completionChunk('', 'stop'),
        'data: [DONE]\n\n',
      ])
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test', stream: true })
    });

    const events = readSse(await res.text());
    const itemDone = events.filter(e => e.type === 'response.output_item.done');
    const fc = itemDone.find(e => e.item.type === 'function_call');
    expect(fc).toBeDefined();
    expect(fc.item.name).toBe('update_plan');
    expect(fc.item.arguments).toBe('{"plan":["a"]}');

    const deltas = events.filter(e => e.type === 'response.output_text.delta');
    expect(deltas.map(d => d.text).join('')).not.toContain('TOOL_CALL');
  });

  it('handles a chunk boundary between [TOOL_CALLS and its closing bracket', async () => {
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      sseResponse([
        completionChunk('[TOOL_CALLS'),
        completionChunk(']\n{"name": "f", "arguments": {"k": 1}}\n[/TOOL_CALLS]'),
        completionChunk('', 'stop'),
        'data: [DONE]\n\n',
      ])
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test', stream: true })
    });

    const events = readSse(await res.text());
    const fc = events.filter(e => e.type === 'response.output_item.done').find(e => e.item.type === 'function_call');
    expect(fc.item.name).toBe('f');
    expect(fc.item.arguments).toBe('{"k":1}');
  });

  it('still parses a well-formed [TOOL_CALL] arriving one character at a time', async () => {
    const payload = 'ok\n\n[TOOL_CALL]\n{"name": "g", "arguments": {}}\n[/TOOL_CALL]\ndone';
    vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(
      sseResponse([...payload.split('').map(ch => completionChunk(ch)), completionChunk('', 'stop'), 'data: [DONE]\n\n'])
    );

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test', stream: true })
    });

    const events = readSse(await res.text());
    const fc = events.filter(e => e.type === 'response.output_item.done').find(e => e.item.type === 'function_call');
    expect(fc.item.name).toBe('g');
    const deltas = events.filter(e => e.type === 'response.output_text.delta');
    expect(deltas.map(d => d.text).join('')).not.toContain('TOOL_CALL');
  });

  it('renders tool result input into upstream prompt', async () => {
    const spy = vi.spyOn(client, 'generateCompletion').mockResolvedValueOnce(jsonCompletion('ok'));

    await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3.8-max',
        input: [
          { type: 'message', role: 'user', content: 'weather in tokyo?' },
          { type: 'function_call', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
          { type: 'function_call_output', output: '{"temp":22}' },
        ],
        tools: [{ type: 'function', name: 'get_weather', description: 'get weather' }],
      })
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const sentMessages = spy.mock.calls[0][1];
    const prompt = sentMessages[0].content;
    expect(prompt).toContain('[TOOL_RESULT]');
    expect(prompt).toContain('{"temp":22}');
    expect(prompt).toContain('"name": "get_weather", "arguments": {"city":"Tokyo"}');
  });

  it('returns 500 when upstream throws', async () => {
    vi.spyOn(client, 'generateCompletion').mockRejectedValueOnce(new Error('upstream down'));

    const res = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.8-max', input: 'test' })
    });

    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error.message).toBe('upstream down');
  });
});
