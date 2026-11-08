// عميل بسيط لـ Gemini عبر REST مع البث (streaming). لا نحتاج أي مكتبة إضافية.

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export class GeminiError extends Error {
  constructor(status, detail) {
    super(`Gemini API error ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

// يستخرج النص من حدث SSE واحد (نتجاهل أجزاء "التفكير" الداخلية إن وُجدت)
function extractText(rawEvent) {
  const data = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');

  if (!data) return '';

  try {
    const json = JSON.parse(data);
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    return parts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('');
  } catch {
    return '';
  }
}

export async function* streamReply({ apiKey, model, system, contents, signal }) {
  const response = await fetch(`${BASE_URL}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new GeminiError(response.status, detail);
  }

  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    // الأحداث مفصولة بسطر فارغ
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const rawEvent = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const text = extractText(rawEvent);
      if (text) yield text;
    }
  }

  const rest = extractText(buffer);
  if (rest) yield rest;
}
