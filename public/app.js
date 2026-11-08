(() => {
  'use strict';

  // ---------- عناصر الصفحة ----------
  const $ = (selector) => document.querySelector(selector);
  const els = {
    chatList: $('#chatList'),
    chatTitle: $('#chatTitle'),
    messages: $('#messages'),
    inner: $('#messagesInner'),
    input: $('#input'),
    composer: $('#composer'),
    sendBtn: $('#sendBtn'),
    sendIcon: $('#sendIcon'),
    attachBtn: $('#attachBtn'),
    fileInput: $('#fileInput'),
    attachments: $('#attachments'),
    newChat: $('#newChat'),
    menuBtn: $('#menuBtn'),
    scrim: $('#scrim'),
    themeBtn: $('#themeBtn'),
    themeIcon: $('#themeIcon'),
    paletteBtn: $('#paletteBtn'),
    palette: $('#palette'),
    swatches: document.querySelectorAll('.swatch'),
    fontSelect: $('#fontSelect'),
    toast: $('#toast'),
    year: $('#year'),
  };

  const DEFAULT_TITLE = 'Lynx AI';
  const MAX_FILES = 4;
  const FONTS = {
    tajawal: "'Tajawal', system-ui, sans-serif",
    cairo: "'Cairo', 'Tajawal', system-ui, sans-serif",
    amiri: "'Amiri', 'Tajawal', serif",
  };
  const TEXT_EXT = /\.(txt|md|csv|json|js|ts|py|html|css|xml|ya?ml|log|sql|java|c|cpp|cs|go|rs|php|sh)$/i;

  const SUGGESTIONS = [
    'اشرح لي نظرية فيثاغورس مع معادلات وأمثلة',
    'اعمل لي جدول مقارنة بين لغات البرمجة الشائعة',
    'اكتب كود بايثون يطبع الأعداد الأولية حتى 100',
    'اقترح لي أفكار لمنتجات رقمية يمكنني بيعها',
  ];

  // ---------- الحالة ----------
  const state = {
    chatId: null,
    chats: [],
    pending: [], // مرفقات جاهزة للإرسال
    busy: false,
    controller: null,
  };

  // ---------- التخزين المحلي ----------
  const store = {
    get(key, fallback = null) {
      try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch { /* وضع التصفح الخاص */ }
    },
  };

  // ---------- هوية الجهاز (بدون حساب) ----------
  // نحفظ المعرّف في localStorage ونسخة احتياطية في كوكي، فإن مُسح أحدهما نسترجعه من الآخر.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function makeUuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function getDeviceId() {
    const cookie = document.cookie.match(/(?:^|;\s*)lynx_device=([^;]+)/)?.[1];
    let id = store.get('lynx.device');
    if (!UUID_RE.test(id || '')) id = UUID_RE.test(cookie || '') ? cookie : makeUuid();
    store.set('lynx.device', id);
    document.cookie = `lynx_device=${id}; max-age=31536000; path=/; SameSite=Lax`;
    return id;
  }

  const deviceId = getDeviceId();

  // ---------- طلبات الشبكة ----------
  async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId, ...options.headers },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'حدث خطأ غير متوقع');
    }
    return response;
  }

  // ---------- إشعارات ----------
  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), 3200);
  }

  // ---------- الثيم والألوان والخط ----------
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    els.themeIcon.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
    store.set('lynx.theme', theme);
  }

  function applyAccent(accent) {
    document.documentElement.dataset.accent = accent;
    els.swatches.forEach((s) => s.setAttribute('aria-pressed', String(s.dataset.accent === accent)));
    store.set('lynx.accent', accent);
  }

  function applyFont(font) {
    if (!FONTS[font]) font = 'tajawal';
    document.documentElement.style.setProperty('--font-body', FONTS[font]);
    els.fontSelect.value = font;
    store.set('lynx.font', font);
  }

  // ---------- Markdown + معادلات + أكواد ----------
  // الـ Markdown يُفسد رموز LaTeX (مثل \( و _)، فنحميها قبل المعالجة ونعيدها بعدها.
  function protectMath(text) {
    const stash = [];
    const keep = (match) => `LYNXMATH${stash.push(match) - 1}X`;
    const out = text
      .replace(/\$\$[\s\S]+?\$\$/g, keep)
      .replace(/\\\[[\s\S]+?\\\]/g, keep)
      .replace(/\\\([\s\S]+?\\\)/g, keep)
      .replace(/(?<![\\$\d])\$(?!\s)[^\n$]+?(?<!\s)\$(?!\d)/g, keep);
    return { out, stash };
  }

  const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function renderMarkdown(el, text, final) {
    if (!window.marked || !window.DOMPurify) {
      el.textContent = text;
      return;
    }
    const { out, stash } = protectMath(text);
    let html = DOMPurify.sanitize(marked.parse(out, { gfm: true, breaks: true }));
    html = html.replace(/LYNXMATH(\d+)X/g, (_, i) => escapeHtml(stash[i] ?? ''));
    el.innerHTML = html;
    if (final) decorate(el);
  }

  function decorate(el) {
    el.querySelectorAll('a').forEach((a) => {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });

    el.querySelectorAll('table').forEach((table) => {
      const wrap = document.createElement('div');
      wrap.className = 'table-wrap';
      table.replaceWith(wrap);
      wrap.append(table);
    });

    el.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      if (!code) return;
      if (window.hljs) hljs.highlightElement(code);

      const lang = (code.className.match(/language-([\w+-]+)/) || [])[1] || 'code';
      const box = document.createElement('div');
      box.className = 'code-block';
      box.innerHTML = `<div class="code-head"><span>${escapeHtml(lang)}</span>
        <button type="button" class="code-copy"><svg class="icon"><use href="#i-copy"/></svg><span>نسخ</span></button></div>`;
      pre.replaceWith(box);
      box.append(pre);

      box.querySelector('.code-copy').addEventListener('click', async (event) => {
        const label = event.currentTarget.querySelector('span');
        try {
          await navigator.clipboard.writeText(code.textContent);
          label.textContent = 'تم ✓';
        } catch {
          label.textContent = 'تعذّر النسخ';
        }
        setTimeout(() => (label.textContent = 'نسخ'), 1500);
      });
    });

    if (window.renderMathInElement) {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '\\(', right: '\\)', display: false },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
      });
    }
  }

  // ---------- عرض الرسائل ----------
  function isNearBottom() {
    const m = els.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 140;
  }

  function scrollToBottom(force = false) {
    if (force || isNearBottom()) els.messages.scrollTop = els.messages.scrollHeight;
  }

  function fileTile(attachment) {
    if (attachment.thumb) {
      const tile = document.createElement('div');
      tile.className = 'thumb';
      const img = document.createElement('img');
      img.src = attachment.thumb;
      img.alt = attachment.name;
      tile.append(img);
      return tile;
    }
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = '<svg class="icon"><use href="#i-file"/></svg><span></span>';
    chip.querySelector('span').textContent = attachment.name;
    return chip;
  }

  function addMessage(role, message = {}) {
    const wrap = document.createElement('article');
    wrap.className = `msg ${role}`;

    if (role === 'user' && message.attachments?.length) {
      const files = document.createElement('div');
      files.className = 'msg-files';
      message.attachments.forEach((a) => files.append(fileTile(a)));
      wrap.append(files);
    }

    const body = document.createElement('div');
    body.className = role === 'assistant' ? 'msg-body md' : 'msg-body';
    body.dir = 'auto';

    if (role === 'user') {
      if (message.text) body.textContent = message.text;
      else body.hidden = true;
    } else if (message.text) {
      renderMarkdown(body, message.text, true);
    }

    wrap.append(body);
    els.inner.append(wrap);
    return body;
  }

  function showWelcome() {
    els.inner.innerHTML = `
      <div class="welcome">
        <h2>أهلاً بك في Lynx 🐾</h2>
        <p>اسألني عن أي شيء: كود، حسابات، جداول، أفكار… أو أرفق صورة أو ملفاً.</p>
        <div class="suggestions"></div>
      </div>`;
    const box = els.inner.querySelector('.suggestions');
    SUGGESTIONS.forEach((text) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'suggestion';
      btn.textContent = text;
      btn.addEventListener('click', () => sendMessage(text));
      box.append(btn);
    });
  }

  function renderConversation(messages) {
    els.inner.innerHTML = '';
    if (!messages.length) return showWelcome();
    messages.forEach((m) => addMessage(m.role, m));
    scrollToBottom(true);
  }

  // ---------- قائمة المحادثات ----------
  function formatDate(timestamp) {
    return new Date(timestamp).toLocaleDateString('ar', { month: 'short', day: 'numeric' });
  }

  function renderChatList() {
    els.chatList.innerHTML = '';
    if (!state.chats.length) {
      els.chatList.innerHTML = '<p class="empty-list">لا توجد محادثات بعد ✨</p>';
      return;
    }

    state.chats.forEach((chat) => {
      const item = document.createElement('div');
      item.className = 'chat-item' + (chat.id === state.chatId ? ' active' : '');
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.innerHTML = `<div class="meta"><span class="name"></span><span class="date"></span></div>
        <button type="button" class="del" aria-label="حذف المحادثة"><svg class="icon"><use href="#i-trash"/></svg></button>`;
      item.querySelector('.name').textContent = chat.title;
      item.querySelector('.date').textContent = formatDate(chat.updatedAt);

      item.addEventListener('click', () => openChat(chat.id));
      item.addEventListener('keydown', (e) => {
        if (e.target === item && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          openChat(chat.id);
        }
      });
      item.querySelector('.del').addEventListener('click', (e) => {
        e.stopPropagation();
        removeChat(chat);
      });
      els.chatList.append(item);
    });
  }

  async function refreshChats() {
    try {
      state.chats = await (await api('/chats')).json();
      renderChatList();
    } catch (err) {
      toast(err.message);
    }
  }

  async function openChat(id) {
    if (state.busy) return toast('انتظر حتى ينتهي الرد الحالي ⏳');
    try {
      const chat = await (await api(`/chats/${id}`)).json();
      state.chatId = chat.id;
      els.chatTitle.textContent = chat.title;
      renderConversation(chat.messages);
      renderChatList();
      closeDrawer();
      els.input.focus();
    } catch (err) {
      toast(err.message);
      refreshChats();
    }
  }

  function startNewChat() {
    if (state.busy) return toast('انتظر حتى ينتهي الرد الحالي ⏳');
    state.chatId = null;
    els.chatTitle.textContent = DEFAULT_TITLE;
    clearPending();
    showWelcome();
    renderChatList();
    closeDrawer();
    els.input.focus();
  }

  async function removeChat(chat) {
    if (!confirm(`حذف المحادثة "${chat.title}"؟ لا يمكن التراجع.`)) return;
    try {
      await api(`/chats/${chat.id}`, { method: 'DELETE' });
      if (chat.id === state.chatId) {
        state.chatId = null;
        els.chatTitle.textContent = DEFAULT_TITLE;
        showWelcome();
      }
      await refreshChats();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------- المرفقات ----------
  const readAsBase64 = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('تعذّرت قراءة الملف'));
      reader.readAsDataURL(file);
    });

  // نصغّر الصورة قبل الرفع (أسرع وأخف)، ونصنع منها مصغّرة للعرض
  async function prepareImage(file) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('هذا النوع من الصور غير مدعوم في متصفحك');
    }
    const draw = (maxSide, quality) => {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', quality);
    };
    const full = draw(1600, 0.85);
    const thumb = draw(160, 0.7);
    bitmap.close?.();
    return { name: file.name, mime: 'image/jpeg', data: full.split(',')[1], thumb };
  }

  async function prepareFile(file) {
    if (file.type.startsWith('image/')) return prepareImage(file);

    if (file.type === 'application/pdf') {
      if (file.size > 8 * 1024 * 1024) throw new Error('ملف PDF كبير، الحد الأقصى 8 ميغابايت');
      return { name: file.name, mime: file.type, data: await readAsBase64(file) };
    }

    if (file.type.startsWith('text/') || TEXT_EXT.test(file.name)) {
      if (file.size > 200 * 1024) throw new Error('الملف النصي كبير، الحد الأقصى 200 كيلوبايت');
      return { name: file.name, mime: 'text/plain', text: await file.text() };
    }

    throw new Error('نوع الملف غير مدعوم');
  }

  async function addFiles(fileList) {
    for (const file of fileList) {
      if (state.pending.length >= MAX_FILES) {
        toast(`الحد الأقصى ${MAX_FILES} مرفقات`);
        break;
      }
      try {
        state.pending.push(await prepareFile(file));
      } catch (err) {
        toast(err.message);
      }
    }
    renderPending();
  }

  function renderPending() {
    els.attachments.innerHTML = '';
    state.pending.forEach((attachment, index) => {
      const tile = fileTile(attachment);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'remove';
      remove.setAttribute('aria-label', 'إزالة المرفق');
      remove.innerHTML = '<svg class="icon"><use href="#i-x"/></svg>';
      remove.addEventListener('click', () => {
        state.pending.splice(index, 1);
        renderPending();
      });
      tile.append(remove);
      els.attachments.append(tile);
    });
  }

  function clearPending() {
    state.pending = [];
    renderPending();
  }

  // ---------- الإرسال والبث ----------
  function setBusy(busy) {
    state.busy = busy;
    els.sendBtn.classList.toggle('stop', busy);
    els.sendBtn.setAttribute('aria-label', busy ? 'إيقاف' : 'إرسال');
    els.sendIcon.setAttribute('href', busy ? '#i-stop' : '#i-up');
  }

  async function readEvents(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let index;
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const line = raw.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let event;
        try { event = JSON.parse(line.slice(5)); } catch { continue; /* حدث غير مكتمل */ }
        onEvent(event);
      }
    }
  }

  async function sendMessage(forcedText) {
    if (state.busy) return;

    const text = (forcedText ?? els.input.value).trim();
    const files = state.pending.slice();
    if (!text && !files.length) return;

    setBusy(true);
    let replyBody = null;
    let full = ''; // النص المستلم حتى الآن من الرد

    try {
      // المحادثة تُنشأ عند أول رسالة فقط، فلا تتراكم محادثات فارغة
      if (!state.chatId) {
        const created = await (await api('/chats', { method: 'POST' })).json();
        state.chatId = created.id;
        els.inner.innerHTML = '';
      }
      els.inner.querySelector('.welcome')?.remove();

      addMessage('user', {
        text,
        attachments: files.map(({ name, mime, thumb }) => ({ name, mime, thumb })),
      });
      els.input.value = '';
      autosize();
      clearPending();

      replyBody = addMessage('assistant');
      replyBody.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
      scrollToBottom(true);

      state.controller = new AbortController();
      const response = await fetch(`/api/chats/${state.chatId}/messages`, {
        method: 'POST',
        signal: state.controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId },
        body: JSON.stringify({ text, attachments: files }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || 'تعذّر إرسال الرسالة');
      }

      let frame = 0;
      const paint = () => {
        frame = 0;
        const stick = isNearBottom();
        renderMarkdown(replyBody, full, false);
        if (stick) scrollToBottom(true);
      };

      await readEvents(response, (event) => {
        if (event.t) {
          full += event.t;
          if (!frame) frame = requestAnimationFrame(paint);
        } else if (event.error) {
          throw new Error(event.error);
        } else if (event.done && event.title) {
          els.chatTitle.textContent = event.title;
        }
      });

      cancelAnimationFrame(frame);
      renderMarkdown(replyBody, full, true);
      scrollToBottom();
    } catch (err) {
      if (!replyBody) {
        toast(err.message);
      } else if (err.name === 'AbortError') {
        // أوقف المستخدم الرد: نُبقي ما وصل منه، أو نزيل الفقاعة الفارغة
        if (full) renderMarkdown(replyBody, full, true);
        else replyBody.closest('.msg').remove();
      } else if (full) {
        renderMarkdown(replyBody, full, true);
        toast(err.message);
      } else {
        replyBody.classList.add('error');
        replyBody.textContent = `⚠️ ${err.message}`;
      }
    } finally {
      state.controller = null;
      setBusy(false);
      refreshChats();
    }
  }

  // ---------- مربع الكتابة ----------
  function autosize() {
    els.input.style.height = 'auto';
    els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
  }

  const isTouch = matchMedia('(pointer: coarse)').matches;

  els.input.addEventListener('input', autosize);
  els.input.addEventListener('keydown', (e) => {
    // على الجوال Enter سطر جديد، وعلى الحاسوب Enter يرسل
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });

  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) state.controller?.abort(); // الزر يتحول إلى "إيقاف" أثناء الرد
    else sendMessage();
  });

  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    addFiles([...els.fileInput.files]);
    els.fileInput.value = '';
  });

  // ---------- القائمة الجانبية على الجوال ----------
  const closeDrawer = () => document.body.classList.remove('drawer-open');
  els.menuBtn.addEventListener('click', () => document.body.classList.toggle('drawer-open'));
  els.scrim.addEventListener('click', closeDrawer);
  els.newChat.addEventListener('click', startNewChat);

  // ---------- الإعدادات ----------
  els.themeBtn.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });

  els.paletteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = els.palette.hidden;
    els.palette.hidden = !open;
    els.paletteBtn.setAttribute('aria-expanded', String(open));
  });
  els.palette.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => {
    els.palette.hidden = true;
    els.paletteBtn.setAttribute('aria-expanded', 'false');
  });

  els.swatches.forEach((s) => s.addEventListener('click', () => applyAccent(s.dataset.accent)));
  els.fontSelect.addEventListener('change', () => applyFont(els.fontSelect.value));

  // ---------- الانطلاق ----------
  els.year.textContent = new Date().getFullYear();
  applyTheme(document.documentElement.dataset.theme);
  applyAccent(document.documentElement.dataset.accent);
  applyFont(store.get('lynx.font', 'tajawal'));
  showWelcome();
  refreshChats();
})();
