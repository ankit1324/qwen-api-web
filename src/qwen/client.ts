import * as crypto from 'crypto';
import { getBaxiaTokens, type BaxiaTokens } from './baxia';

const QWEN_BASE_URL = 'https://chat.qwen.ai';
const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const WEB_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,en;q=0.8';
const VERSION = '0.2.83';

type ChatMode = 'normal' | 'guest';

function uuid() { return crypto.randomUUID(); }

function riskControlled(text: string): boolean {
  return /FAIL_SYS_USER_VALIDATE|RGV587|rgv587|action=captcha|punish/i.test(text);
}

function extractText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p === 'string') { parts.push(p); continue; }
    if (p.type === 'text' || p.type === 'input_text') {
      if (typeof p.text === 'string') parts.push(p.text);
    }
  }
  return parts.join('\n');
}

function parseIncomingMessages(messages: any[]): string {
  const safe = Array.isArray(messages) ? messages : [];
  const norm = safe.map((m: any) => ({ role: m?.role || 'user', text: extractText(m?.content) }));
  if (norm.length === 0) return '';
  const last = norm[norm.length - 1];
  const history = norm.slice(0, -1).map(m => {
    if (!m.text) return '';
    const r = m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'System' : 'User';
    return `[${r}]: ${m.text}`;
  }).filter(Boolean).join('\n\n');
  return history ? `${history}\n\n[User]: ${last.text}` : last.text;
}

function baseHeaders(tokens: BaxiaTokens, mode: ChatMode, token: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'bx-ua': tokens.bxUa,
    'bx-umidtoken': tokens.bxUmidToken,
    'bx-v': tokens.bxV,
    'Origin': QWEN_BASE_URL,
    'Referer': `${QWEN_BASE_URL}/c/guest`,
    'source': 'web',
    'version': VERSION,
    'User-Agent': WEB_USER_AGENT,
    'Accept-Language': WEB_ACCEPT_LANGUAGE,
    'x-request-id': uuid(),
  };
  if (mode === 'normal' && token) h['Authorization'] = `Bearer ${token}`;
  if (tokens.cookies) h['Cookie'] = tokens.cookies;
  return h;
}

async function createChatSession(tokens: BaxiaTokens, model: string, chatType: string, mode: ChatMode, token: string | null): Promise<string> {
  const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chats/new`, {
    method: 'POST',
    headers: baseHeaders(tokens, mode, token),
    body: JSON.stringify({ title: '新建对话', models: [model], chat_mode: mode, chat_type: chatType, timestamp: Date.now(), project_id: '' }),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Failed to create chat session: HTTP ${resp.status}`);
  let data: any;
  try { data = JSON.parse(text); } catch { throw new Error(`Failed to create chat session: non-JSON`); }
  if (!data.success || !data.data?.id) throw new Error(`Failed to create chat session: ${text.slice(0, 300)}`);
  return data.data.id;
}

function completionBody(chatId: string, model: string, content: string, chatType: string, mode: ChatMode): any {
  const fid = uuid(), childId = uuid();
  return {
    stream: true, version: '2.1', incremental_output: true,
    chat_id: chatId, chat_mode: mode, model, parent_id: null,
    messages: [{ id: null, fid, parentId: null, childrenIds: [childId], role: 'user', content, user_action: 'chat', files: [], timestamp: Date.now(), models: [model], model: '', chat_type: chatType, feature_config: { thinking_enabled: true, output_schema: 'phase', research_mode: 'normal', auto_thinking: true, thinking_mode: 'Auto', thinking_format: 'summary', auto_search: false }, extra: { meta: { subChatType: chatType } }, sub_chat_type: chatType, parent_id: null }],
    timestamp: Date.now(),
  };
}

function mapUpstreamDelta(delta: any): any {
  if (!delta || typeof delta !== 'object') return null;
  const mapped: any = {};
  if (delta.role === 'assistant') mapped.role = delta.role;
  if (typeof delta.content === 'string') mapped.content = delta.content;
  const rc = extractReasoning(delta);
  if (rc) mapped.reasoning_content = rc;
  return Object.keys(mapped).length > 0 ? mapped : null;
}

function extractReasoning(delta: any): string {
  if (!delta || typeof delta !== 'object') return '';
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) return delta.reasoning_content;
  if (delta.phase !== 'thinking_summary') return '';
  const tc = delta?.extra?.summary_thought?.content;
  if (Array.isArray(tc)) return tc.map((i: any) => typeof i === 'string' ? i : i?.content || i?.text || '').filter(Boolean).join('\n');
  return '';
}

interface SseEvent { delta: any; finish_reason: string | null; usage: any; }

function parseSseEvents(payload: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const line of payload.split('\n')) {
    const t = line.trimStart();
    if (!t.startsWith('data:')) continue;
    const d = t.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      const p = JSON.parse(d);
      const ud = p?.choices?.[0]?.delta;
      const delta = mapUpstreamDelta(ud);
      const fr = p?.choices?.[0]?.finish_reason || null;
      const usage = p?.usage || null;
      if (delta || fr) out.push({ delta: delta || {}, finish_reason: fr, usage });
    } catch { }
  }
  return out;
}

function mapUsage(usage: any): any {
  const it = Number(usage?.input_tokens || 0);
  const ot = Number(usage?.output_tokens || 0);
  return { prompt_tokens: it, completion_tokens: ot, total_tokens: Number(usage?.total_tokens || (it + ot)) };
}

function openaiChunk(id: string, created: number, model: string, delta: any, finish: string | null): string {
  return `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: delta || {}, finish_reason: finish }]})}\n\n`;
}

interface AttemptConfig { mode: ChatMode; token: string | null; }

function attemptPlan(token: string | null): AttemptConfig[] {
  return token ? [{ mode: 'normal', token }, { mode: 'guest', token: null }] : [{ mode: 'guest', token: null }];
}

export async function generateCompletion(model: string, messages: any[], stream: boolean, token: string | null = null): Promise<Response> {
  const actualModel = model || 'qwen3.8-max';
  const chatType = 't2t';
  const plan = attemptPlan(token);

  for (const cfg of plan) {
    let lastErr: Error | null = null;
    const maxAttempts = cfg.mode === 'normal' ? 0 : 3;
    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      const tokens = await getBaxiaTokens(attempt > 0);
      try {
        const chatId = await createChatSession(tokens, actualModel, chatType, cfg.mode, cfg.token);
        const content = parseIncomingMessages(messages);

        const resp = await fetch(`${QWEN_BASE_URL}/api/v2/chat/completions?chat_id=${chatId}`, {
          method: 'POST',
          headers: { ...baseHeaders(tokens, cfg.mode, cfg.token), 'x-accel-buffering': 'no' },
          body: JSON.stringify(completionBody(chatId, actualModel, content, chatType, cfg.mode)),
        });

        const contentType = resp.headers.get('content-type') || '';
        const responseId = `chatcmpl-${uuid()}`;
        const created = Math.floor(Date.now() / 1000);

        if (contentType.includes('application/json')) {
          const text = await resp.text();
          if (riskControlled(text)) {
            lastErr = new Error(`Upstream risk control (${cfg.mode} mode)`);
            await new Promise(r => setTimeout(r, 600));
            continue;
          }
          throw new Error(`Upstream error: ${resp.status} - ${text.slice(0, 300)}`);
        }

        if (!stream) {
          const text = await resp.text();
          const events = parseSseEvents(text);
          const contentParts = events.map(e => e.delta?.content || '').filter(Boolean);
          const reasoningParts = events.map(e => e.delta?.reasoning_content || '').filter(Boolean);
          const usageEvent = [...events].reverse().find(e => e.usage)?.usage || null;
          return new Response(JSON.stringify({
            id: responseId, object: 'chat.completion', created, model: actualModel,
            choices: [{ index: 0, message: { role: 'assistant', content: contentParts.join(''), ...(reasoningParts.length > 0 ? { reasoning_content: reasoningParts.join('\n') } : {}) }, finish_reason: 'stop' }],
            usage: mapUsage(usageEvent),
          }), { headers: { 'Content-Type': 'application/json' } });
        }

        // Streaming
        const encoder = new TextEncoder();
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();

        const readable = new ReadableStream<Uint8Array>({
          async start(controller) {
            let buffer = '';
            let finished = false;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf('\n\n')) >= 0) {
                  const rawEvent = buffer.slice(0, idx);
                  buffer = buffer.slice(idx + 2);
                  const line = rawEvent.split('\n').find(l => l.trimStart().startsWith('data:'));
                  if (!line) continue;
                  const data = line.slice(5).trim();
                  if (!data || data === '[DONE]') continue;
                  try {
                    const parsed = JSON.parse(data);
                    const ud = parsed?.choices?.[0]?.delta;
                    const delta = mapUpstreamDelta(ud);
                    const fr = parsed?.choices?.[0]?.finish_reason || null;
                    if (delta || fr) {
                      controller.enqueue(encoder.encode(openaiChunk(responseId, created, actualModel, delta || {}, fr)));
                      if (fr) finished = true;
                    }
                  } catch { }
                }
              }
              if (!finished) {
                controller.enqueue(encoder.encode(openaiChunk(responseId, created, actualModel, {}, 'stop')));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            } catch (e: any) {
              controller.error(e);
              return;
            }
            controller.close();
          },
        });

        return new Response(readable, {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
        });
      } catch (e: any) {
        const msg = e?.message || String(e);
        if (riskControlled(msg)) { lastErr = e; await new Promise(r => setTimeout(r, 600)); continue; }
        throw e;
      }
    }
    if (lastErr && plan.length > 1) {
      continue; // try next mode (guest)
    }
    if (lastErr) throw lastErr;
  }
  throw new Error('Upstream request failed');
}