import { Hono } from 'hono';
import { getConfig } from '../config';
import { generateCompletion } from '../qwen/client';
import { logToolCall } from '../logger';
import * as crypto from 'crypto';
import * as fs from 'fs';

const responses = new Hono();

const TOOL_OPEN = '[TOOL_CALL]';
const TOOL_CLOSE = '[/TOOL_CALL]';
const RESULT_OPEN = '[TOOL_RESULT]';
const RESULT_CLOSE = '[/TOOL_RESULT]';

// Auth Middleware
responses.use('/v1/*', async (c, next) => {
  const config = getConfig();
  if (config.api_keys && config.api_keys.length > 0) {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: { message: "Unauthorized" } }, 401);
    }
    const token = authHeader.replace('Bearer ', '').trim();
    if (!config.api_keys.includes(token)) {
      return c.json({ error: { message: "Invalid API key" } }, 401);
    }
  }
  await next();
});

function debugLog(label: string, data: any): void {
  if (!process.env.QWEN_DEBUG_LOG) return;
  try {
    fs.appendFileSync('/tmp/qwen-responses-debug.log', `\n===== ${label} =====\n` + JSON.stringify(data, null, 2) + '\n');
  } catch { }
}

function textFromContentPart(part: any): string {
  if (!part) return '';
  if (typeof part === 'string') return part;
  if (typeof part.text === 'string' && ['input_text', 'output_text', 'text', 'summary_text'].includes(part.type)) return part.text;
  if (part.type === 'input_image') return '[image omitted]';
  return '';
}

function normalizeOutput(output: any): string {
  let out = output;
  if (out && typeof out === 'object' && Array.isArray(out.content)) {
    out = out.content.map(textFromContentPart).filter(Boolean).join('\n');
  } else if (out && typeof out === 'object') {
    const inner = typeof out.output === 'string' ? out.output : out;
    try { out = typeof inner === 'string' ? inner : JSON.stringify(inner); } catch { out = String(inner); }
  }
  return typeof out === 'string' ? out : String(out ?? '');
}

function renderInputItem(item: any): string | null {
  if (!item) return null;
  switch (item.type) {
    case 'message': {
      const text = typeof item.content === 'string'
        ? item.content
        : (Array.isArray(item.content) ? item.content.map(textFromContentPart).filter(Boolean).join('\n') : '');
      return text ? `[${item.role || 'user'}]: ${text}` : null;
    }
    case 'function_call': {
      let args = item.arguments;
      if (typeof args !== 'string') { try { args = JSON.stringify(args); } catch { args = '{}'; } }
      return `${TOOL_OPEN}\n{"name": ${JSON.stringify(item.name)}, "arguments": ${args}}\n${TOOL_CLOSE}`;
    }
    case 'function_call_output': {
      return `${RESULT_OPEN}\n${normalizeOutput(item.output)}\n${RESULT_CLOSE}`;
    }
    default:
      return null;
  }
}

function renderTools(tools: any[]): string {
  const lines: string[] = [];
  for (const t of tools || []) {
    if (!t || !t.name) continue;
    lines.push(`<tool name="${t.name}">`);
    if (t.description) lines.push(t.description);
    if (t.parameters) lines.push(`Parameters JSON schema: ${JSON.stringify(t.parameters)}`);
    lines.push('</tool>');
  }
  return lines.join('\n');
}

function buildPrompt(body: any): string {
  const { input, instructions, tools } = body;
  const sections: string[] = [];

  if (typeof instructions === 'string' && instructions.trim()) sections.push(instructions.trim());

  const toolDefs = Array.isArray(tools) ? tools.filter((t: any) => t?.name) : [];
  if (toolDefs.length > 0) {
    sections.push([
      '# Tools',
      '',
      'You can call tools to help answer. Available tools:',
      '',
      '<tools>',
      renderTools(toolDefs),
      '</tools>',
      '',
      '# How to call tools',
      '',
      'When you need to use a tool, emit exactly this format:',
      '',
      TOOL_OPEN,
      '{"name": "TOOL_NAME", "arguments": {ARGUMENTS_OBJECT}}',
      TOOL_CLOSE,
      '',
      'Rules:',
      '- The JSON inside the block must be valid: name is the tool name, arguments is the exact JSON object matching the tool\'s parameters schema.',
      '- Emit tool call blocks INSTEAD of writing out what you would do. Never fabricate tool results.',
      '- After emitting a tool call block, STOP. The result will arrive in the next turn as a [TOOL_RESULT] block. You may then continue.',
      '- If no tool is needed, answer in plain text without any tool_call blocks.',
      `- Use ONLY the exact ${TOOL_OPEN} ... ${TOOL_CLOSE} format above. Do NOT use any other syntax for tool calls: no [TOOL_CALLS], no <tool_call> tags, no function-call-style code blocks, no bare tool names on their own line. If you are unsure of the format, do not attempt a tool call at all — answer in plain text instead.`,
    ].join('\n'));
  }

  const items = Array.isArray(input) ? input : (typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : []);
  const rendered = items.map(renderInputItem).filter(Boolean) as string[];
  if (rendered.length > 0) {
    sections.push(['# Conversation so far', '', ...rendered].join('\n'));
  }

  return sections.join('\n\n');
}

interface ParsedToolCall { name: string; arguments: string; }

// Canonical marker: [TOOL_CALL]...[/TOOL_CALL]. The model sometimes drifts to a plural
// "[TOOL_CALLS]" variant, or drops the closing bracket entirely (e.g. "[TOOL_CALLS\n<name>\n...").
// OPEN/CLOSE_VARIANT_RE catch the bracketed drift; OPEN_BARE catches the bracket-less drift,
// which is handled in a separate "soft" mode terminated by a blank line instead of a close marker.
const OPEN_CLOSE_VARIANT_RE = /\[\/?TOOL_CALLS?\]/i;
const OPEN_BARE_RE = /\[TOOL_CALLS?/i;
const OPEN_BARE_LONGEST = '[TOOL_CALLS';
const BRACKETED_MARKERS = ['[TOOL_CALL]', '[TOOL_CALLS]'];
const BRACKETED_LONGEST = '[TOOL_CALLS]';
const MALFORMED_TOOL_CALL_CAP = 8192;

class ToolCallParser {
  private buf = '';
  private mode: 'text' | 'tool' | 'soft' = 'text';
  calls: ParsedToolCall[] = [];

  private safeTextLen(): number {
    const max = Math.min(this.buf.length, OPEN_BARE_LONGEST.length - 1);
    for (let k = max; k > 0; k--) {
      if (this.buf.endsWith(OPEN_BARE_LONGEST.slice(0, k))) return this.buf.length - k;
    }
    return this.buf.length;
  }

  private parseCall(raw: string): ParsedToolCall | null {
    const s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    // Clean case: the whole block is `{"name": ..., "arguments": ...}`.
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj.name === 'string') {
        let args = obj.arguments ?? {};
        if (typeof args !== 'string') args = JSON.stringify(args);
        return { name: obj.name, arguments: args };
      }
    } catch { }
    // Soft-mode salvage: a bare tool name on its own line followed by a JSON object,
    // e.g. "update_plan\n{...}". Anything without an embedded JSON object is not recoverable.
    const jsonStart = s.indexOf('{');
    if (jsonStart > 0) {
      const head = s.slice(0, jsonStart).trim().split(/\s+/)[0];
      if (head && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(head)) {
        try {
          const obj = JSON.parse(s.slice(jsonStart));
          if (obj && typeof obj === 'object') {
            let args = obj.arguments ?? obj;
            if (typeof args !== 'string') args = JSON.stringify(args);
            return { name: head, arguments: args };
          }
        } catch { }
      }
    }
    return null;
  }

  private findCloseVariant(): { index: number; length: number } | null {
    const m = OPEN_CLOSE_VARIANT_RE.exec(this.buf);
    return m ? { index: m.index, length: m[0].length } : null;
  }

  /**
   * True when the text at `idx` is still a strict prefix of a well-formed bracketed
   * marker, i.e. more input could turn "[TOOL_CALL" into "[TOOL_CALL]". Committing to
   * soft mode there would strand the trailing "]" and corrupt an otherwise valid call,
   * so the caller must wait for more input instead.
   */
  private couldStillCloseBracket(idx: number): boolean {
    const head = this.buf.slice(idx, idx + BRACKETED_LONGEST.length).toUpperCase();
    return BRACKETED_MARKERS.some(m => m.startsWith(head) && head.length < m.length);
  }

  /** Feed streamed text; returns safe-to-emit text. Completed calls appear in this.calls. */
  feed(chunk: string): string {
    this.buf += chunk;
    let out = '';
    while (this.buf) {
      if (this.mode === 'text') {
        const bm = OPEN_CLOSE_VARIANT_RE.exec(this.buf);
        const bareM = OPEN_BARE_RE.exec(this.buf);
        if (!bm && !bareM) {
          const safeLen = this.safeTextLen();
          out += this.buf.slice(0, safeLen);
          this.buf = this.buf.slice(safeLen);
          break;
        }
        if (bm && (!bareM || bm.index <= bareM.index)) {
          out += this.buf.slice(0, bm.index);
          this.buf = this.buf.slice(bm.index + bm[0].length);
          this.mode = 'tool';
        } else if (bareM) {
          // "[TOOL_CALL" may still be the start of a well-formed "[TOOL_CALL]"; if the
          // stream cut off mid-marker, wait for the next chunk rather than corrupting it.
          if (this.couldStillCloseBracket(bareM.index)) {
            out += this.buf.slice(0, bareM.index);
            this.buf = this.buf.slice(bareM.index);
            break;
          }
          out += this.buf.slice(0, bareM.index);
          this.buf = this.buf.slice(bareM.index + bareM[0].length);
          this.mode = 'soft';
        }
      } else if (this.mode === 'tool') {
        const close = this.findCloseVariant();
        if (!close) {
          if (this.buf.length > 131072) {
            this.mode = 'text';
            out += TOOL_OPEN + this.buf;
            this.buf = '';
          }
          break;
        }
        const raw = this.buf.slice(0, close.index);
        this.buf = this.buf.slice(close.index + close.length);
        this.mode = 'text';
        const call = this.parseCall(raw);
        if (call) { this.calls.push(call); logToolCall(call.name, call.arguments); }
        else out += TOOL_OPEN + raw + TOOL_CLOSE;
      } else {
        // Soft mode: the open marker was missing its closing bracket. The model usually
        // still emits a proper [/TOOL_CALL] terminator, so prefer that; fall back to a
        // blank line when it doesn't. If neither ever arrives, drop the malformed attempt
        // rather than leak raw bracket/tool-name garbage into the visible answer.
        const closeM = this.findCloseVariant();
        const blankIdx = this.buf.indexOf('\n\n');
        let j = -1;
        let consumed = 0;
        if (closeM && (blankIdx === -1 || closeM.index <= blankIdx)) {
          j = closeM.index;
          consumed = closeM.length;
        } else if (blankIdx !== -1) {
          j = blankIdx;
          consumed = 2;
        }
        if (j === -1) {
          if (this.buf.length > MALFORMED_TOOL_CALL_CAP) {
            this.mode = 'text';
            logToolCall('(malformed)', this.buf.slice(0, 200));
            this.buf = '';
          }
          break;
        }
        const raw = this.buf.slice(0, j);
        this.buf = this.buf.slice(j + consumed);
        this.mode = 'text';
        const call = this.parseCall(raw);
        if (call) { this.calls.push(call); logToolCall(call.name, call.arguments); }
        else logToolCall('(malformed)', raw.slice(0, 200));
      }
    }
    return out;
  }

  /** Flush at end of stream; returns remaining literal text. */
  flush(): string {
    let out = '';
    if (this.mode === 'tool') {
      const close = this.findCloseVariant();
      const raw = close ? this.buf.slice(0, close.index) : this.buf;
      const call = this.parseCall(raw);
      if (call) { this.calls.push(call); logToolCall(call.name, call.arguments); }
      else out += TOOL_OPEN + raw + (close ? TOOL_CLOSE : '');
      this.buf = close ? this.buf.slice(close.index + close.length) : '';
    } else if (this.mode === 'soft') {
      const call = this.parseCall(this.buf);
      if (call) { this.calls.push(call); logToolCall(call.name, call.arguments); }
      else logToolCall('(malformed)', this.buf.slice(0, 200));
      this.buf = '';
    }
    this.mode = 'text';
    out += this.buf;
    this.buf = '';
    return out;
  }
}

interface ChatDelta { content?: string; reasoning?: string; finish: string | null; usage: any; }

async function* consumeChatCompletion(chatRes: Response): AsyncGenerator<ChatDelta> {
  const contentType = chatRes.headers.get('Content-Type') || '';

  if (contentType.includes('text/event-stream')) {
    const reader = chatRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of raw.split('\n')) {
          const t = line.trimStart();
          if (!t.startsWith('data:')) continue;
          const d = t.slice(5).trim();
          if (!d || d === '[DONE]') continue;
          try {
            const parsed = JSON.parse(d);
            const choice = parsed?.choices?.[0];
            const delta = choice?.delta || {};
            if (delta.content !== undefined || delta.reasoning_content !== undefined || choice?.finish_reason) {
              yield { content: delta.content || '', reasoning: delta.reasoning_content || '', finish: choice?.finish_reason || null, usage: parsed?.usage || null };
            }
          } catch { }
        }
      }
    }
    return;
  }

  const obj = await chatRes.json();
  const msg = obj?.choices?.[0]?.message || {};
  if (msg.content !== undefined) {
    yield { content: msg.content || '', reasoning: msg.reasoning_content || '', finish: 'stop', usage: obj?.usage || null };
  }
}

function sseEvent(type: string, payload: Record<string, any>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

function messageItem(id: string, text: string, status: string): any {
  return {
    id, type: 'message', status, role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function buildResponseObject(id: string, model: string, output: any[], usage: any, status: string = 'completed'): any {
  return {
    id, object: 'response', created_at: Math.floor(Date.now() / 1000), status, model, output,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
      total_tokens: usage?.total_tokens || 0,
    },
  };
}

responses.post('/v1/responses', async (c) => {
  const config = getConfig();
  const body = await c.req.json().catch(() => ({}));
  debugLog('request', body);
  const { model = 'qwen3.7-plus', stream = false } = body;

  const prompt = buildPrompt(body);
  if (!prompt.trim()) {
    return c.json({ error: { message: 'No user prompt found in input' } }, 400);
  }

  const messages = [{ role: 'user', content: prompt }];

  try {
    const chatRes = await generateCompletion(model, messages, stream, config.token);
    const responseId = `resp_${crypto.randomUUID()}`;

    if (!stream) {
      const parser = new ToolCallParser();
      let raw = '';
      let usage = null;
      for await (const d of consumeChatCompletion(chatRes)) {
        if (d.content) raw += d.content;
        if (d.usage) usage = d.usage;
      }
      const text = parser.feed(raw) + parser.flush();
      const output: any[] = [];
      if (text || parser.calls.length === 0) output.push(messageItem('msg_1', text, 'completed'));
      for (const call of parser.calls) {
        output.push({
          type: 'function_call', id: `fc_${crypto.randomUUID().slice(0, 8)}`,
          call_id: `call_${crypto.randomUUID().slice(0, 8)}`, name: call.name,
          arguments: call.arguments, status: 'completed',
        });
      }
      return c.json(buildResponseObject(responseId, model, output, usage));
    }

    const encoder = new TextEncoder();
    const readable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (chunk: string) => controller.enqueue(encoder.encode(chunk));
        let seq = 0;
        let outputIndex = 0;
        const items: any[] = [];
        let msgOpen = false;
        let msgCount = 0;
        let msgId = 'msg_1';
        let msgText = '';
        let callsProcessed = 0;
        const parser = new ToolCallParser();
        let usage: any = null;

        const openMessage = () => {
          if (msgOpen) return;
          msgCount++;
          msgId = `msg_${msgCount}`;
          msgOpen = true;
          emit(sseEvent('response.output_item.added', {
            sequence_number: seq++,
            item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
            output_index: outputIndex,
          }));
        };

        const closeMessage = () => {
          if (!msgOpen) return;
          emit(sseEvent('response.output_text.done', {
            sequence_number: seq++, item_id: msgId, output_index: outputIndex, content_index: 0, text: msgText,
          }));
          const item = messageItem(msgId, msgText, 'completed');
          emit(sseEvent('response.output_item.done', {
            sequence_number: seq++, item, output_index: outputIndex,
          }));
          items.push(item);
          outputIndex++;
          msgOpen = false;
          msgText = '';
        };

        const drainCalls = () => {
          while (callsProcessed < parser.calls.length) {
            const call = parser.calls[callsProcessed++];
            closeMessage();
            const fcId = `fc_${crypto.randomUUID().slice(0, 8)}`;
            const callId = `call_${crypto.randomUUID().slice(0, 8)}`;
            emit(sseEvent('response.output_item.added', {
              sequence_number: seq++,
              item: { type: 'function_call', id: fcId, call_id: callId, name: call.name, arguments: '', status: 'in_progress' },
              output_index: outputIndex,
            }));
            emit(sseEvent('response.function_call_arguments.delta', {
              sequence_number: seq++, item_id: fcId, output_index: outputIndex, delta: call.arguments,
            }));
            emit(sseEvent('response.function_call_arguments.done', {
              sequence_number: seq++, item_id: fcId, output_index: outputIndex, arguments: call.arguments,
            }));
            const fcItem = { type: 'function_call', id: fcId, call_id: callId, name: call.name, arguments: call.arguments, status: 'completed' };
            emit(sseEvent('response.output_item.done', {
              sequence_number: seq++, item: fcItem, output_index: outputIndex,
            }));
            items.push(fcItem);
            outputIndex++;
          }
        };

        emit(sseEvent('response.created', {
          sequence_number: seq++,
          response: buildResponseObject(responseId, model, [], null, 'in_progress'),
        }));

        try {
          for await (const d of consumeChatCompletion(chatRes)) {
            if (d.usage) usage = d.usage;
            if (d.content) {
              const safe = parser.feed(d.content);
              if (safe) {
                openMessage();
                msgText += safe;
                emit(sseEvent('response.output_text.delta', {
                  sequence_number: seq++, item_id: msgId, output_index: outputIndex, content_index: 0, text: safe,
                }));
              }
              drainCalls();
            }
          }
          const rest = parser.flush();
          if (rest) {
            openMessage();
            msgText += rest;
            emit(sseEvent('response.output_text.delta', {
              sequence_number: seq++, item_id: msgId, output_index: outputIndex, content_index: 0, text: rest,
            }));
          }
          drainCalls();
        } catch (e: any) {
          debugLog('stream-error', { message: e?.message });
          emit(sseEvent('response.failed', {
            sequence_number: seq++,
            error: { code: 'upstream_error', message: e?.message || 'Upstream error' },
          }));
          controller.close();
          return;
        }
        closeMessage();
        const finalResponse = buildResponseObject(responseId, model, items, usage);
        emit(sseEvent('response.completed', { sequence_number: seq++, response: finalResponse }));
        debugLog('response', finalResponse);
        controller.close();
      },
    });

    return new Response(readable, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  } catch (error: any) {
    return c.json({ error: { message: error.message || 'Unknown error' } }, 500);
  }
});

export default responses;
