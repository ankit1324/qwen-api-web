export async function generateCompletion(model: string, messages: any[], stream: boolean, token: string | null): Promise<Response> {
  if (!token) {
    throw new Error('Qwen token is not configured.');
  }

  const payload = {
    model,
    messages,
    stream
  };

  const response = await fetch('https://chat.qwen.ai/api/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Upstream error: ${response.status} - ${err}`);
  }

  return response;
}
