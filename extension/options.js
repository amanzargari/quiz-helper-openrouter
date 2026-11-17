const $ = id => document.getElementById(id);
const PARSED = course => `__parsed__::${course}`;
const msg = (el, t, ok) => { el.textContent = t; el.className = (el.id === 'msg' ? '' : 'note') + (ok ? '' : ' err'); };

async function load() {
  const s = await chrome.storage.local.get({ apiKey: '', model: '', pdfEngine: 'cloudflare-ai' });
  $('apiKey').value = s.apiKey;
  $('model').value = s.model;
  $('pdfEngine').value = s.pdfEngine;
  if (window.Extract && Extract.pdfReady)
    msg($('pdfStatus'), `PDF reader ready (pdf.js ${Extract.pdfVersion || ''}).`, true);
  else
    msg($('pdfStatus'), 'PDF reader NOT loaded — vendor/pdf.min.js is missing or blocked. Reload the extension.', false);
  renderCourses();
}

$('saveKey').addEventListener('click', async () => {
  await chrome.storage.local.set({ apiKey: $('apiKey').value.trim() });
  msg($('msg'), 'API key saved.', true);
});
$('model').addEventListener('change', () => chrome.storage.local.set({ model: $('model').value.trim() }));
$('pdfEngine').addEventListener('change', () => chrome.storage.local.set({ pdfEngine: $('pdfEngine').value }));

$('loadModels').addEventListener('click', async () => {
  msg($('msg'), 'Loading models…', true);
  try {
    const key = $('apiKey').value.trim();
    const res = await fetch('https://openrouter.ai/api/v1/models',
      key ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
    const { data } = await res.json();
    const vision = data.filter(m => (m.architecture?.input_modalities || []).includes('image'));
    const list = (vision.length ? vision : data).sort((a, b) => a.id.localeCompare(b.id));
    $('models').innerHTML = '';
    for (const m of list) { const o = new Option(`${m.id} — ${m.name || ''}`, m.id); $('models').appendChild(o); }
    msg($('msg'), `Loaded ${list.length} models${vision.length ? ' with image input' : ''}. Type to filter.`, true);
  } catch (e) {
    msg($('msg'), 'Could not load models: ' + e.message, false);
  }
});

$('add').addEventListener('click', async () => {
  const course = $('courseName').value.trim();
  const files = [...$('files').files];
  if (!course) return msg($('addMsg'), 'Enter a course name first.', false);
  if (!files.length) return msg($('addMsg'), 'Pick at least one file.', false);
  msg($('addMsg'), `Adding ${files.length} file(s)…`, true);
  let ok = 0; const errs = [], scanned = [];
  for (const f of files) {
    try {
      const rec = await Extract.fileToRecord(course, f);
      await DB.put(rec); ok++;
      if (rec.scanned) scanned.push(f.name);
    } catch (e) {
      console.error('Add failed for', f.name, e);
      errs.push(`• ${f.name}: ${e && (e.stack || e.message) || e}`);
    }
  }
  await DB.delete(PARSED(course)).catch(() => {});   // files changed -> drop parsed cache
  $('files').value = '';
  let m = `Added ${ok}/${files.length}.`;
  if (scanned.length) m += `\n⚠ Scanned (no text layer), will use OCR — pick "Mistral OCR" above:\n${scanned.join('\n')}`;
  if (errs.length) m += `\n\nFull error(s):\n${errs.join('\n\n')}`;
  msg($('addMsg'), m, !errs.length);
  renderCourses();
});

async function renderCourses() {
  const courses = await DB.courses();
  const box = $('courses');
  box.innerHTML = '';
  if (!courses.length) { box.innerHTML = '<p class="note">No courses yet.</p>'; return; }
  for (const c of courses) {
    const row = document.createElement('div');
    row.className = 'course';
    const bits = [c.pdfs && `${c.pdfs} pdf`, c.texts && `${c.texts} text`, c.images && `${c.images} image`]
      .filter(Boolean).join(', ');
    const kc = c.chars ? ` · ${Math.round(c.chars / 1000)}k chars` : '';
    const name = document.createElement('div');
    name.innerHTML = `<strong>${c.course}</strong><div class="meta">${bits}${kc}</div>`;
    const del = document.createElement('button');
    del.className = 'link'; del.textContent = 'Delete';
    del.addEventListener('click', async () => {
      if (!confirm(`Delete course "${c.course}" and all its files?`)) return;
      await DB.deleteCourse(c.course);
      renderCourses();
    });
    row.append(name, del);
    box.appendChild(row);
  }
}

load();
