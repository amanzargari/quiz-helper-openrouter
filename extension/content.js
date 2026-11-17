// Injected on demand. Reads questions, shows answers in a corner panel.
// By default it does NOT touch the page's own inputs.
(() => {
  if (window.__quizHelper) { window.__qhReady(); return; }
  window.__quizHelper = true;

  const ANSWERABLE = [
    'input[type="radio"]', 'input[type="checkbox"]', '[role="radio"]', '[role="checkbox"]',
    'select', 'textarea', 'input[type="text"]', 'input[type="number"]', 'input:not([type])'
  ].join(',');
  // Moodle (.que), MS Forms ([data-automation-id=questionItem]), Google Forms ([role=listitem]), generic
  const KNOWN_CONTAINERS = '.que, [data-automation-id="questionItem"], [role="listitem"], .question, ' +
                           '[data-question-id], [class*="question-container" i]';
  const EXCLUDE = 'nav, header, footer, [role="navigation"], [role="search"], [role="banner"], ' +
                  '[aria-hidden="true"], .que .info, .questionflag, .qtype_multichoice_clearchoice, ' +
                  '#qh-panel, #qh-panel *';

  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const textOf = el => clean(el.innerText ?? el.textContent);
  const isChecked = el => el.matches('input') ? el.checked : el.getAttribute('aria-checked') === 'true';
  let questions = [];

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
  }
  function labelEl(el) {
    if (el.labels && el.labels.length) return el.labels[0];
    return el.closest('label');
  }
  function labelOf(el) {
    const lab = labelEl(el);
    if (lab && textOf(lab)) return textOf(lab);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = clean(ids.split(/\s+/).map(id => { const n = document.getElementById(id); return n ? textOf(n) : ''; }).join(' '));
      if (t) return t;
    }
    if (el.dataset && el.dataset.value) return clean(el.dataset.value);
    return el.parentElement ? textOf(el.parentElement).slice(0, 300) : '';
  }
  function lca(els) { let a = els[0]; while (a && !els.every(e => a.contains(e))) a = a.parentElement; return a || document.body; }
  function findContainer(els, all) {
    const known = els[0].closest(KNOWN_CONTAINERS);
    if (known && els.every(e => known.contains(e))) return known;
    let c = lca(els), best = c;
    const optLen = els.map(labelOf).join(' ').length;
    for (let i = 0; i < 8 && c && c !== document.body; i++) {
      if (all.some(x => !els.includes(x) && c.contains(x))) break;
      best = c;
      if (textOf(c).length > optLen + 25) break;
      c = c.parentElement;
    }
    return best;
  }
  function checkboxScope(el) {
    let c = el.parentElement;
    for (let i = 0; i < 6 && c && c !== document.body; i++) {
      if (c.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length > 1) return c;
      c = c.parentElement;
    }
    return el;
  }
  function textWithout(el, sel) { const clone = el.cloneNode(true); clone.querySelectorAll(sel).forEach(n => n.remove()); return clean(clone.textContent); }

  function collect() {
    const all = [...document.querySelectorAll(ANSWERABLE)].filter(el =>
      !el.closest(EXCLUDE) && !el.disabled && !(el.name || '').includes('flagged') &&
      (isVisible(el) || isVisible(labelEl(el))));
    const groups = new Map();
    const add = (key, el) => { if (!groups.has(key)) groups.set(key, []); groups.get(key).push(el); };
    all.forEach((el, i) => {
      if (el.matches('input[type="radio"]')) add('r:' + (el.name || i), el);
      else if (el.matches('[role="radio"]'))
        add(el.closest('[role="radiogroup"]') || el.closest(KNOWN_CONTAINERS) || el.parentElement, el);
      else if (el.matches('input[type="checkbox"], [role="checkbox"]'))
        add(el.closest(KNOWN_CONTAINERS) || el.closest('[role="group"]') || checkboxScope(el), el);
      else add('s:' + i, el);
    });
    questions = [];
    let qn = 0;
    for (const els of groups.values()) {
      const first = els[0];
      const container = findContainer(els, all);
      const qid = `q${qn++}`;
      let qtype, options = [];
      if (first.matches('select')) {
        qtype = 'select';
        options = [...first.options]
          .map((o, i) => ({ id: `${qid}o${i}`, text: clean(o.text), el: first, index: i, value: o.value }))
          .filter(o => o.text && o.value !== '' && !/^(choose|select|scegli|seleziona|kies)\b/i.test(o.text));
      } else if (first.matches('textarea, input[type="text"], input[type="number"], input:not([type])')) {
        qtype = 'text';
      } else {
        qtype = first.matches('input[type="checkbox"], [role="checkbox"]') ? 'multi' : 'single';
        options = els.map((el, i) => ({ id: `${qid}o${i}`, text: labelOf(el) || `option ${i + 1}`, el }));
      }
      let question = textOf(container);
      if ((qtype === 'select' || qtype === 'text') && container.querySelectorAll(ANSWERABLE).length > 1) {
        const row = first.closest('tr, li, p') || first.parentElement;
        question = `Sub-item to answer: ${textWithout(row, 'select')}\n\nFull question:\n${question}`;
      }
      questions.push({ qid, qtype, container, els, options, question: question.slice(0, 4000) });
    }
    return questions;
  }

  const slim = q => {
    const r = q.container.getBoundingClientRect();
    return { qid: q.qid, qtype: q.qtype, question: q.question,
             options: q.options.map(({ id, text }) => ({ id, text })), top: r.top, height: r.height };
  };
  function extract(scope) {
    collect();
    if (scope === 'current' && questions.length) {
      const mid = innerHeight / 2; let best = null, bestD = Infinity, anyView = false;
      for (const q of questions) {
        const r = q.container.getBoundingClientRect();
        const inView = r.bottom > 0 && r.top < innerHeight;
        if (inView) anyView = true;
        if (!inView && anyView) continue;
        const d = Math.abs((r.top + r.height / 2) - mid);
        if ((inView || !anyView) && d < bestD) { bestD = d; best = q; }
      }
      return best ? [slim(best)] : [];
    }
    return questions.map(slim);
  }

  async function focus(qid) {
    const q = questions.find(x => x.qid === qid); if (!q) return null;
    const el = q.container;
    const fits = el.getBoundingClientRect().height < innerHeight * 0.9;
    el.scrollIntoView({ block: fits ? 'center' : 'start', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 400));
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  }

  const fire = el => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
  // Click like a real user: custom widgets (Wooclap, MS Forms) often listen to pointer/mouse
  // events rather than 'click', and hidden native inputs need their visible label clicked.
  function press(el) {
    const target = isVisible(el) ? el : (labelEl(el) || el.parentElement || el);
    target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    const r = target.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', o));
    target.dispatchEvent(new PointerEvent('pointerup', { ...o, pointerType: 'mouse', isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', o));
    target.click();
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));
  async function pick(el, want) {
    if (isChecked(el) === want) return;
    press(el);
    await wait(150);
    if (isChecked(el) !== want && el.matches('input')) el.click();   // fallback for plain inputs
  }

  function setValue(el, v) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); fire(el);
  }

  // ---------- corner panel ----------
  let panel, list;
  function ensurePanel() {
    if (panel && document.body.contains(panel)) return;
    panel = document.createElement('div'); panel.id = 'qh-panel';
    panel.innerHTML =
      '<div class="qh-head"><span class="qh-title">Quiz Helper</span>' +
      '<span class="qh-count"></span><button class="qh-min" title="Collapse">–</button>' +
      '<button class="qh-x" title="Hide">✕</button></div><div class="qh-list"></div>';
    document.documentElement.appendChild(panel);
    list = panel.querySelector('.qh-list');
    const head = panel.querySelector('.qh-head');
    panel.querySelector('.qh-x').onclick = () => panel.remove();
    panel.querySelector('.qh-min').onclick = () => panel.classList.toggle('qh-collapsed');
    // draggable
    let sx, sy, ox, oy, drag = false;
    head.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = panel.getBoundingClientRect(); ox = r.left; oy = r.top;
      panel.style.right = 'auto'; e.preventDefault();
    });
    addEventListener('mousemove', e => { if (!drag) return; panel.style.left = (ox + e.clientX - sx) + 'px'; panel.style.top = (oy + e.clientY - sy) + 'px'; });
    addEventListener('mouseup', () => drag = false);
  }

  function panelRow(q, msg, chosen) {
    ensurePanel();
    let row = list.querySelector(`[data-qid="${q.qid}"]`);
    if (!row) { row = document.createElement('div'); row.className = 'qh-item'; row.dataset.qid = q.qid; list.appendChild(row); }
    const pct = Math.round((msg.confidence || 0) * 100);
    const picked = q.qtype === 'text' ? (msg.text_answer || '') : q.options.filter(o => chosen.has(o.id)).map(o => o.text).join(' • ');
    row.className = 'qh-item' + (pct < 50 ? ' qh-low' : '') + (msg.cached ? ' qh-cached' : '');
    row.innerHTML =
      `<div class="qh-row1"><span class="qh-num">Q${msg.num || ''}</span>` +
      `<span class="qh-pct">${msg.cached ? '♻' : ''}${pct}%</span></div>` +
      `<div class="qh-ans"></div><div class="qh-why"></div>`;
    row.querySelector('.qh-ans').textContent = picked || '—';
    row.querySelector('.qh-why').textContent = msg.reason || '';
    row.onclick = () => q.container.scrollIntoView({ block: 'center', behavior: 'smooth' });
    panel.querySelector('.qh-count').textContent = list.children.length + ' answered';
  }

  async function apply(msg) {
    const q = questions.find(x => x.qid === msg.qid); if (!q) return false;
    const chosen = new Set(msg.answer_ids || []);
    if (msg.highlight) {
      if (q.qtype === 'single' || q.qtype === 'multi')
        for (const o of q.options) (labelEl(o.el) || o.el.parentElement || o.el).classList.toggle('qh-pick', chosen.has(o.id));
      else q.els[0].classList.add('qh-pick');
    }
    if (msg.autoClick) {
      if (q.qtype === 'single') { const o = q.options.find(o => chosen.has(o.id)); if (o) await pick(o.el, true); }
      else if (q.qtype === 'multi') { for (const o of q.options) { await pick(o.el, chosen.has(o.id)); await wait(80); } }
      else if (q.qtype === 'select') { const o = q.options.find(o => chosen.has(o.id)); if (o) { o.el.selectedIndex = o.index; fire(o.el); } }
      else if (q.qtype === 'text' && msg.text_answer) setValue(q.els[0], msg.text_answer);
    }
    if (msg.showPanel !== false) panelRow(q, msg, chosen);
    return true;
  }

  function clearAll() {
    document.querySelectorAll('.qh-pick').forEach(n => n.classList.remove('qh-pick'));
    if (panel) panel.remove();
    panel = list = null;
    return true;
  }

  const style = document.createElement('style');
  style.textContent = `
    #qh-panel { position: fixed; top: 12px; right: 12px; z-index: 2147483647; width: 300px; max-width: 86vw;
      max-height: 80vh; display: flex; flex-direction: column; background: #0b3a24; color: #ecfdf5;
      border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.35); font: 13px/1.4 system-ui, sans-serif; overflow: hidden; }
    #qh-panel .qh-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; background: #0f5132; cursor: move; }
    #qh-panel .qh-title { font-weight: 700; }
    #qh-panel .qh-count { margin-left: auto; opacity: .8; font-size: 12px; }
    #qh-panel .qh-head button { background: transparent; border: none; color: #ecfdf5; cursor: pointer; font-size: 14px; padding: 0 4px; }
    #qh-panel .qh-list { overflow: auto; padding: 4px; }
    #qh-panel.qh-collapsed .qh-list { display: none; }
    #qh-panel .qh-item { padding: 7px 8px; border-radius: 7px; margin: 4px; background: rgba(255,255,255,.06); cursor: pointer; }
    #qh-panel .qh-item:hover { background: rgba(255,255,255,.12); }
    #qh-panel .qh-item.qh-low { background: rgba(234,88,12,.22); }
    #qh-panel .qh-item.qh-cached { background: rgba(37,99,235,.20); }
    #qh-panel .qh-row1 { display: flex; justify-content: space-between; font-size: 11px; opacity: .85; }
    #qh-panel .qh-ans { font-weight: 600; margin-top: 2px; }
    #qh-panel .qh-why { font-size: 11px; opacity: .8; margin-top: 2px; }
    .qh-pick { outline: 3px solid #16a34a !important; outline-offset: 2px; border-radius: 4px; background-color: rgba(22,163,74,.10) !important; }`;
  document.documentElement.appendChild(style);

  window.__qhReady = () => {};
  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    (async () => {
      switch (msg.type) {
        case 'extract': return extract(msg.scope || 'all');
        case 'focus': return focus(msg.qid);
        case 'apply': return apply(msg);
        case 'clear': return clearAll();
      }
    })().then(send, e => send({ error: String(e) }));
    return true;
  });
})();
