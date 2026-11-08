import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage } from './lib/storage.js';
import { streamReply, GeminiError } from './lib/gemini.js';
import { SYSTEM_INSTRUCTION } from './lib/persona.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

const MAX_HISTORY = 30; // آخر 30 رسالة تُرسل كسياق للنموذج
const MAX_TEXT = 20_000;
const MAX_ATTACHMENTS = 4;
const INLINE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);

if (!API_KEY) {
  console.warn('⚠️  GEMINI_API_KEY غير مضبوط، لن يعمل الذكاء الاصطناعي.');
}

const storage = createStorage(DATA_DIR);
const app = express();

app.set('trust proxy', 1); // Render يعمل خلف بروكسي
app.disable('x-powered-by');
app.use(express.json({ limit: '24mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

// ---------- أدوات مساعدة ----------

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// حدّ بسيط: 20 رسالة في الدقيقة لكل عنوان IP
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const recent = (hits.get(req.ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 20) {
    return res.status(429).json({ error: 'رسائل كثيرة بسرعة ⏳ انتظر دقيقة ثم حاول مجدداً.' });
  }
  recent.push(now);
  hits.set(req.ip, recent);
  next();
}
setInterval(() => hits.clear(), 10 * 60_000).unref();

// كل طلب لمسار /api يجب أن يحمل معرّف الجهاز
app.use('/api', (req, res, next) => {
  const id = req.get('x-device-id');
  if (!storage.isValidDevice(id)) {
    return res.status(400).json({ error: 'معرّف الجهاز غير صالح.' });
  }
  req.deviceId = id.toLowerCase();
  next();
});

// تنظيف المدخلات القادمة من المتصفح
function parseMessageBody(body = {}) {
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, MAX_TEXT) : '';
  const rawList = Array.isArray(body.attachments) ? body.attachments.slice(0, MAX_ATTACHMENTS) : [];

  const inline = []; // صور و PDF تُرسل لـ Gemini كما هي
  const fileTexts = []; // ملفات نصية تُدمج داخل الرسالة
  const shown = []; // ما يُحفظ ويُعرض في المحادثة

  for (const item of rawList) {
    const name = String(item?.name ?? 'file').slice(0, 120);
    const mime = String(item?.mime ?? '');
    const thumb =
      typeof item?.thumb === 'string' && item.thumb.startsWith('data:image/') && item.thumb.length < 60_000
        ? item.thumb
        : undefined;

    if (typeof item?.text === 'string') {
      fileTexts.push(`📎 ${name}:\n\`\`\`\n${item.text.slice(0, 200_000)}\n\`\`\``);
      shown.push({ name, mime: 'text/plain' });
    } else if (typeof item?.data === 'string' && INLINE_MIMES.has(mime)) {
      inline.push({ inlineData: { mimeType: mime, data: item.data } });
      shown.push({ name, mime, thumb });
    }
  }

  return { text, inline, extra: fileTexts.join('\n\n'), shown };
}

// تحويل المحادثة المحفوظة إلى صيغة Gemini
function toHistory(messages) {
  const history = messages.slice(-MAX_HISTORY).map((m) => {
    const fallback = `[مرفق: ${(m.attachments || []).map((a) => a.name).join('، ')}]`;
    const text = [m.text, m.extra].filter(Boolean).join('\n\n') || fallback;
    return { role: m.role === 'user' ? 'user' : 'model', parts: [{ text }] };
  });
  while (history.length && history[0].role === 'model') history.shift();
  return history;
}

function friendlyError(err) {
  if (err instanceof GeminiError) {
    if (err.status === 429) return 'تم تجاوز حدّ الاستخدام لدى Gemini حالياً، حاول بعد قليل ⏳';
    if (err.status === 400 || err.status === 404) return 'تعذّر الوصول للنموذج، تحقق من اسم النموذج ومفتاح API في إعدادات الاستضافة 🔧';
    if (err.status === 401 || err.status === 403) return 'مفتاح Gemini API غير صالح أو غير مسموح 🔑';
  }
  return 'حدث خطأ أثناء توليد الرد، حاول مرة أخرى 🙏';
}

// ---------- المحادثات ----------

app.get('/api/chats', wrap(async (req, res) => {
  res.json(await storage.listChats(req.deviceId));
}));

app.post('/api/chats', wrap(async (req, res) => {
  const chat = await storage.createChat(req.deviceId);
  res.status(201).json({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt });
}));

app.get('/api/chats/:chatId', wrap(async (req, res) => {
  const chat = await storage.getChat(req.deviceId, req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
  res.json(chat);
}));

app.delete('/api/chats/:chatId', wrap(async (req, res) => {
  await storage.deleteChat(req.deviceId, req.params.chatId);
  res.status(204).end();
}));

// إرسال رسالة واستقبال الرد بالبث (Server-Sent Events)
app.post('/api/chats/:chatId/messages', rateLimit, wrap(async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: 'الخدمة غير مُعدّة بعد (مفتاح API مفقود).' });

  const chat = await storage.getChat(req.deviceId, req.params.chatId);
  if (!chat) return res.status(404).json({ error: 'المحادثة غير موجودة.' });

  const { text, inline, extra, shown } = parseMessageBody(req.body);
  if (!text && !inline.length && !extra) {
    return res.status(400).json({ error: 'الرسالة فارغة.' });
  }

  // نحفظ رسالة المستخدم فوراً، فلا تضيع حتى لو تعطّل شيء لاحقاً
  const isFirst = chat.messages.length === 0;
  chat.messages.push({ role: 'user', text, extra: extra || undefined, attachments: shown, at: Date.now() });
  if (isFirst) {
    chat.title = (text || shown[0]?.name || 'محادثة جديدة').replace(/\s+/g, ' ').slice(0, 40);
  }
  await storage.saveChat(req.deviceId, chat);

  // الرسالة الأخيرة تحمل المرفقات الفعلية؛ ما قبلها نصوص فقط
  const contents = toHistory(chat.messages.slice(0, -1));
  contents.push({
    role: 'user',
    parts: [{ text: [text, extra].filter(Boolean).join('\n\n') || 'حلّل هذا المرفق.' }, ...inline],
  });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  // إذا أغلق المستخدم الصفحة أو ضغط "إيقاف" نقطع الطلب لـ Gemini
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let reply = '';
  try {
    for await (const piece of streamReply({
      apiKey: API_KEY,
      model: MODEL,
      system: SYSTEM_INSTRUCTION,
      contents,
      signal: controller.signal,
    })) {
      reply += piece;
      send({ t: piece });
    }

    if (!reply) {
      reply = 'لم أستطع الرد على هذه الرسالة 😅 جرّب صياغة مختلفة.';
      send({ t: reply });
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('[gemini]', err.status ?? '', err.detail ?? err.message);
      send({ error: friendlyError(err) });
    }
  }

  // نحفظ الرد (حتى لو كان جزئياً بعد إيقاف المستخدم)
  if (reply) {
    chat.messages.push({ role: 'assistant', text: reply, at: Date.now() });
    await storage.saveChat(req.deviceId, chat).catch((err) => console.error('[save]', err));
  }

  if (!res.writableEnded) {
    send({ done: true, title: chat.title });
    res.end();
  }
}));

// ---------- الأخطاء ----------

app.use('/api', (req, res) => res.status(404).json({ error: 'المسار غير موجود.' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'المرفقات كبيرة جداً، قلّل حجمها.' });
  }
  console.error(err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'خطأ داخلي في السيرفر.' });
});

app.listen(PORT, () => {
  console.log(`🐾 Lynx AI يعمل على المنفذ ${PORT} (النموذج: ${MODEL})`);
});
