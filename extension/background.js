/* Service worker: owns the "chat" with OpenRouter.
   - Builds one init message from the course files (PDF parsed once, then cached as text).
   - Each question is a new turn in the same conversation (history is resent; OpenRouter is stateless).
   - A question already answered in this session is re-marked from cache, never re-asked. */
importScripts('db.js');

const API = 'https://openrouter.ai/api/v1';
const PARSED = course => `__parsed__::${course}`;      // DB id of the cached PDF-parse text
const sleep = ms => new Promise(r => setTimeout(r, ms));

const defaults = {
  apiKey: '', model: '', course: '', autoClick: false, highlight: false,
  showPanel: true, useImage: true, savePng: true, pdfEngine: 'cloudflare-ai'
};
const getSettings = () => chrome.storage.local.get(defaults);

function progress(text, badge = '') {
  chrome.runtime.sendMessage({ type: 'progress', text }).catch(() => {});
  chrome.action.setBadgeText({ text: badge });
}

// ---------- session (per tab, survives SW restarts via storage.session) ----------
const sKey = tabId => `session:${tabId}`;

async function getSession(tabId) {
  const o = await chrome.storage.session.get(sKey(tabId));
  return o[sKey(tabId)] || null;
}
async function saveSession(tabId, s) {
  await chrome.storage.session.set({ [sKey(tabId)]: s });
}
async function resetSession(tabId) {
  await chrome.storage.session.remove(sKey(tabId));
}

function hashQ(q) {
  const norm = t => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const str = norm(q.question) + '|' + q.options.map(o => norm(o.text)).sort().join('#');
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------- course materials -> init message ----------
const toB64 = buf => {
  const u = new Uint8Array(buf); let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
};

async function buildInit(course, engine) {
  const recs = (await DB.byCourse(course)).filter(r => r.type !== 'parsed');
  const parsed = (await DB.byCourse(course)).find(r => r.type === 'parsed');
  const texts = recs.filter(r => r.type === 'text');
  const images = recs.filter(r => r.type === 'image');
  const pdfs = recs.filter(r => r.type === 'pdf');

  let intro = `You are helping with the practice quiz for the course "${course}". ` +
    `Below are the course materials. Study them. I will then send quiz questions one at a time; ` +
    `answer each using these materials first, and your own knowledge if they don't cover it.\n`;
  for (const t of texts) intro += `\n\n===== FILE: ${t.name} =====\n${t.text}`;
  if (parsed) intro += `\n\n${parsed.text}`;        // cached text parsed from the PDFs

  const content = [{ type: 'text', text: intro }];
  for (const im of images) content.push({ type: 'image_url', image_url: { url: im.dataUrl } });

  let plugins;
  const needParse = !parsed && pdfs.length > 0;
  if (needParse) {
    for (const p of pdfs)
      content.push({ type: 'file', file: { filename: p.name, file_data: `data:application/pdf;base64,${toB64(p.data)}` } });
    plugins = [{ id: 'file-parser', pdf: { engine } }];
  }
  return { content, needParse, plugins, counts: { texts: texts.length, images: images.length, pdfs: pdfs.length } };
}

function questionContent(q, image) {
  const hint = {
    single: 'single choice - pick exactly ONE option id',
    multi: 'multiple answer - pick ALL correct option ids',
    select: 'dropdown - pick exactly ONE option id',
    text: 'free text - put the answer in text_answer'
  }[q.qtype] || q.qtype;
  let text = `New question.\nTYPE: ${hint}\nQUESTION:\n${q.question}`;
  if (q.options.length) text += '\nOPTIONS:\n' + q.options.map(o => `[${o.id}] ${o.text}`).join('\n');
  text += '\n\nReply ONLY as JSON: {"reason": "...", "answer_ids": [...], "text_answer": "...", "confidence": 0-1}. ' +
          'answer_ids must be option ids exactly as shown in brackets.';
  const parts = [{ type: 'text', text }];
  if (image) parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } });
  return parts;
}

const SYSTEM = 'You answer practice-quiz questions using the course materials provided in the first message. ' +
  'Think carefully, then reply ONLY with the requested JSON object and nothing else.';

function parseAnswer(raw, q) {
  let txt = (raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = JSON.parse(txt);
  const valid = new Set(q.options.map(o => o.id));
  let ids = (a.answer_ids || []).filter(i => valid.has(i));
  if (q.qtype === 'single' || q.qtype === 'select') ids = ids.slice(0, 1);
  let conf = Number(a.confidence) || 0;
  if (conf > 1) conf /= 100;
  return {
    answer_ids: ids,
    text_answer: q.qtype === 'text' ? (a.text_answer || '') : '',
    confidence: Math.max(0, Math.min(1, conf)),
    reason: a.reason || ''
  };
}

function extractParsedText(data) {
  const anns = data?.choices?.[0]?.message?.annotations || data?.error?.metadata?.file_annotations || [];
  const seen = new Set(), blocks = [];
  for (const an of anns) {
    if (an?.type !== 'file' || !an.file?.hash || seen.has(an.file.hash)) continue;
    seen.add(an.file.hash);
    const body = (an.file.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    blocks.push(`===== FILE: ${an.file.name || 'document.pdf'} =====\n${body}`);
  }
  return blocks.join('\n\n');
}

async function post(settings, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Quiz Helper'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'Request timed out' : `Network error: ${e.message}`);
  }
  clearTimeout(timer);
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function callOpenRouter(settings, messages, plugins, wantJson = true) {
  const body = { model: settings.model, messages, temperature: 0 };
  if (wantJson) body.response_format = { type: 'json_object' };
  if (plugins) body.plugins = plugins;
  let { res, data } = await post(settings, body);
  if (!res.ok && wantJson && res.status !== 401 && res.status !== 402) {   // some models reject json mode
    delete body.response_format;
    ({ res, data } = await post(settings, body));
  }
  if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const content = data?.choices?.[0]?.message?.content;
  if (content == null && !data?.choices?.[0]?.message?.annotations) throw new Error('Empty response from model');
  return { content, data };
}

// Parse PDFs once (optionally without a question) and cache the text in the DB.
async function ensurePrepared(settings, tabId) {
  let session = await getSession(tabId);
  if (session && session.course === settings.course) return session;

  session = { course: settings.course, model: settings.model, qa: [], answered: {} };
  const init = await buildInit(settings.course, settings.pdfEngine);
  if (init.needParse) {
    progress('Parsing course PDFs (one-time)…');
    const messages = [
      { role: 'system', content: 'You will receive course materials to study.' },
      { role: 'user', content: [...init.content, { type: 'text', text: 'Reply with just: READY' }] }
    ];
    const { data } = await callOpenRouter(settings, messages, init.plugins, false);
    const parsedText = extractParsedText(data);
    if (parsedText) {
      await DB.put({ id: PARSED(settings.course), course: settings.course, type: 'parsed',
                     text: parsedText, chars: parsedText.length, addedAt: Date.now() });
    } else {
      console.warn('No PDF annotations returned; PDFs will be sent with each question.');
    }
  }
  await saveSession(tabId, session);
  return session;
}

async function solveQuestion(settings, session, q, image) {
  const h = hashQ(q);
  if (session.answered[h]) return { ...session.answered[h], cached: true };   // dedup

  const init = await buildInit(session.course, settings.pdfEngine);   // text-only now if parsed cached
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: init.content },
    ...session.qa.slice(-24),                     // keep recent turns bounded
    { role: 'user', content: questionContent(q, image) }
  ];
  const { content } = await callOpenRouter(settings, messages, init.needParse ? init.plugins : undefined);
  const ans = parseAnswer(content, q);

  session.qa.push({ role: 'user', content: questionContent(q, null)[0].text });  // store text only
  session.qa.push({ role: 'assistant', content: JSON.stringify(ans) });
  session.answered[h] = ans;
  return { ...ans, cached: false };
}

// ---------- screenshot ----------
let lastCapture = 0;
async function captureCrop(windowId, r) {
  const wait = 600 - (Date.now() - lastCapture);
  if (wait > 0) await sleep(wait);
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  lastCapture = Date.now();
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const k = bmp.width / r.vw, pad = 8;
  const x0 = Math.max(0, (r.x - pad) * k), y0 = Math.max(0, (r.y - pad) * k);
  const x1 = Math.min(bmp.width, (r.x + r.w + pad) * k), y1 = Math.min(bmp.height, (r.y + r.h + pad) * k);
  const sw = x1 - x0, sh = y1 - y0;
  if (sw < 20 || sh < 20) return null;
  const scale = Math.min(1, 1280 / sw);
  const canvas = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale));
  canvas.getContext('2d').drawImage(bmp, x0, y0, sw, sh, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return toB64(await blob.arrayBuffer());
}


// ---------- save answer image to a local folder (Downloads/QuizHelper) ----------
function dataUrlFrom(blobB64, mime) { return `data:${mime};base64,${blobB64}`; }

async function composeAnswerImage(screenshotB64, caption) {
  const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + screenshotB64)).blob());
  const pad = 10, lineH = 18, font = '14px system-ui, sans-serif', W = bmp.width;
  const meas = new OffscreenCanvas(W, 10).getContext('2d'); meas.font = font;
  const lines = [];
  for (const para of caption.split('\n')) {
    let cur = '';
    for (const w of para.split(/\s+/)) {
      const t = cur ? cur + ' ' + w : w;
      if (meas.measureText(t).width > W - 2 * pad && cur) { lines.push(cur); cur = w; } else cur = t;
    }
    lines.push(cur);
  }
  const barH = pad * 2 + lines.length * lineH;
  const canvas = new OffscreenCanvas(W, bmp.height + barH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  ctx.fillStyle = '#0b3a24'; ctx.fillRect(0, bmp.height, W, barH);
  ctx.fillStyle = '#ecfdf5'; ctx.font = font; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, pad, bmp.height + pad + i * lineH));
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  return dataUrlFrom(toB64(await blob.arrayBuffer()), 'image/jpeg');
}

const sanitize = s => (s || 'course').replace(/[^\w.-]+/g, '_').slice(0, 40);

async function saveAnswer(course, num, image, caption) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = `QuizHelper/${sanitize(course)}/${ts}_q${num}`;
  let url, ext;
  if (image) { url = await composeAnswerImage(image, caption); ext = 'jpg'; }
  else { url = 'data:text/plain;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(caption))); ext = 'txt'; }
  try { await chrome.downloads.download({ url, filename: `${base}.${ext}`, saveAs: false, conflictAction: 'uniquify' }); }
  catch (e) { console.warn('save failed', e); }
}

function pickedText(q, ans) {
  return q.qtype === 'text' ? (ans.text_answer || '—')
    : (q.options.filter(o => ans.answer_ids.includes(o.id)).map(o => o.text).join(' | ') || '—');
}

function captionFor(q, ans) {
  const picked = q.qtype === 'text' ? ans.text_answer
    : q.options.filter(o => ans.answer_ids.includes(o.id)).map(o => o.text).join(' | ');
  const pct = Math.round((ans.confidence || 0) * 100);
  return `Answer (${pct}%): ${picked || '—'}` + (ans.reason ? `\n${ans.reason}` : '');
}

// ---------- main ----------
let running = false;

async function run(tabId, scope) {
  if (running) return { error: 'Already running' };
  running = true;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    const settings = await getSettings();
    if (!settings.apiKey) throw new Error('Add your OpenRouter API key in options');
    if (!settings.model) throw new Error('Choose a model in options');
    if (!settings.course) throw new Error('Choose a course in the popup');

    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    const qs = await chrome.tabs.sendMessage(tabId, { type: 'extract', scope });
    if (!Array.isArray(qs)) throw new Error(qs?.error || 'Could not read the page');
    if (!qs.length) throw new Error('No question found');

    const session = await ensurePrepared(settings, tabId);

    let done = 0, reused = 0;
    const errors = [], lines = [];
    session.lastAnswers = [];
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      progress(qs.length > 1 ? `Question ${i + 1} of ${qs.length}…` : 'Thinking…', `${i + 1}/${qs.length}`);
      try {
        let image = null;
        if (settings.useImage) {
          const rect = await chrome.tabs.sendMessage(tabId, { type: 'focus', qid: q.qid });
          const tab = await chrome.tabs.get(tabId);
          if (rect && tab.active) image = await captureCrop(tab.windowId, rect);
        }
        const ans = await solveQuestion(settings, session, q, image);
        await saveSession(tabId, session);
        await chrome.tabs.sendMessage(tabId, {
          type: 'apply', qid: q.qid, num: i + 1, showPanel: settings.showPanel,
          autoClick: settings.autoClick, highlight: settings.highlight, ...ans
        });
        if (settings.savePng && !ans.cached) await saveAnswer(session.course, i + 1, image, captionFor(q, ans));
        const line = `Q${i + 1}: ${pickedText(q, ans)} (${Math.round((ans.confidence || 0) * 100)}%)`;
        lines.push(line); session.lastAnswers.push(line);
        ans.cached ? reused++ : done++;
      } catch (e) {
        errors.push(`Q${i + 1}: ${e.message}`);
      }
    }
    await saveSession(tabId, session);
    const head = `Answered ${done}${reused ? `, reused ${reused}` : ''}`;
    const summary = [head, ...lines, ...errors].join('\n');
    progress(summary, errors.length ? '!' : '✓');
    return { ok: true, summary };
  } catch (e) {
    progress('Error: ' + e.message, '!');
    return { error: e.message };
  } finally {
    clearInterval(keepAlive);
    running = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'solve': return run(msg.tabId, msg.scope || 'current');
      case 'prepare': {
        const settings = await getSettings();
        if (!settings.course) return { error: 'Choose a course first' };
        if (!settings.apiKey || !settings.model) return { error: 'Set API key and model first' };
        await resetSession(msg.tabId);
        const ka = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
        try { await ensurePrepared(settings, msg.tabId); progress('Course ready.', ''); return { ok: true }; }
        catch (e) { progress('Error: ' + e.message, '!'); return { error: e.message }; }
        finally { clearInterval(ka); }
      }
      case 'reset': await resetSession(msg.tabId); progress('New session started.', '');
                    chrome.tabs.sendMessage(msg.tabId, { type: 'clear' }).catch(() => {}); return { ok: true };
      case 'clear': chrome.tabs.sendMessage(msg.tabId, { type: 'clear' }).catch(() => {});
                    chrome.action.setBadgeText({ text: '' }); return { ok: true };
      case 'status': {
        const s2 = await getSession(msg.tabId);
        const { course, apiKey, model } = await getSettings();
        return { prepared: !!(s2 && s2.course === course), course, hasCreds: !!(apiKey && model) };
      }
      case 'lastAnswers': { const s3 = await getSession(msg.tabId); return { lines: (s3 && s3.lastAnswers) || [] }; }
      case 'courses': return { courses: await DB.courses() };
    }
  })().then(sendResponse, e => sendResponse({ error: String(e) }));
  return true;
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd !== 'solve-current') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) run(tab.id, 'current');
});
