import { Hono } from 'hono';
import { getConfig } from '../config';

const models = new Hono();

export const GUEST_MODELS = [
  { id: "qwen3.7-plus", object: "model", created: 1732711466, owned_by: "qwen" },
  { id: "qwen3.8-max", object: "model", created: 1732711466, owned_by: "qwen" },
];

export interface QwenModel {
  id: string;
  name: string;
  object: string;
  owned_by: string;
}

export async function fetchModelsFromUpstream(token: string | null): Promise<QwenModel[]> {
  if (!token) return [];
  try {
    const resp = await fetch('https://chat.qwen.ai/api/models', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
        'source': 'web',
        'version': '0.2.83',
        'Origin': 'https://chat.qwen.ai',
        'Referer': 'https://chat.qwen.ai/',
      },
    });
    if (!resp.ok) return [];
    const data: any = await resp.json();
    const list: any[] = data?.data || data?.models || [];
    return list
      .filter((m: any) => m?.id)
      .map((m: any) => ({ id: m.id, name: m.name || m.id, object: m.object || 'model', owned_by: m.owned_by || 'qwen' }));
  } catch {
    return [];
  }
}

export function toOpenAIModel(m: QwenModel) {
  return {
    id: m.id,
    object: m.object || 'model',
    created: 1732711466,
    owned_by: m.owned_by || 'qwen',
  };
}

models.get('/v1/models', async (c) => {
  const config = getConfig();
  const upstream = await fetchModelsFromUpstream(config.token);
  const data = upstream.length > 0 ? upstream.map(toOpenAIModel) : GUEST_MODELS;
  return c.json({ object: "list", data });
});

export default models;