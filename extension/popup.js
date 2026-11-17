const $ = id => document.getElementById(id);
const setStatus = t => { $('status').textContent = t; };
const send = msg => chrome.runtime.sendMessage(msg);
async function tabId() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t?.id; }

async function init() {
  const s = await chrome.storage.local.get({ course: '', showPanel: true, useImage: true, savePng: true, highlight: false, autoClick: false, apiKey: '', model: '' });
  $('showPanel').checked = s.showPanel;
  $('useImage').checked = s.useImage;
  $('savePng').checked = s.savePng;
  $('highlight').checked = s.highlight;
  $('autoClick').checked = s.autoClick;

  const { courses } = await send({ type: 'courses' });
  $('course').innerHTML = '';
  if (!courses || !courses.length) { setStatus('No courses yet. Open "Manage courses" to add your files.'); return; }
  for (const c of courses) {
    const bits = [c.pdfs && `${c.pdfs} pdf`, c.texts && `${c.texts} text`, c.images && `${c.images} img`].filter(Boolean);
    $('course').add(new Option(`${c.course}${bits.length ? '  (' + bits.join(', ') + ')' : ''}`, c.course, false, c.course === s.course));
  }
  if (!courses.some(c => c.course === s.course)) await chrome.storage.local.set({ course: courses[0].course });

  if (!s.apiKey || !s.model) { setStatus('Set your API key and model in "Manage courses".'); return; }

  // Prime the course up front (parse PDFs once) so the first question is fast.
  const st = await send({ type: 'status', tabId: await tabId() });
  if (st && !st.prepared) {
    setStatus('Preparing course…');
    const r = await send({ type: 'prepare', tabId: await tabId() });
    setStatus(r?.error ? 'Error: ' + r.error : 'Ready. Model: ' + s.model);
  } else {
    setStatus('Ready. Model: ' + s.model);
  }
  const la = await send({ type: 'lastAnswers', tabId: await tabId() });
  if (la && la.lines && la.lines.length) setStatus('Last answers:\n' + la.lines.join('\n'));
}

$('course').addEventListener('change', async e => {
  await chrome.storage.local.set({ course: e.target.value });
  await send({ type: 'reset', tabId: await tabId() });
  setStatus('Preparing course…');
  const r = await send({ type: 'prepare', tabId: await tabId() });
  setStatus(r?.error ? 'Error: ' + r.error : 'Course ready.');
});
$('showPanel').addEventListener('change', async e => {
  await chrome.storage.local.set({ showPanel: e.target.checked });
  if (!e.target.checked) await send({ type: 'clear', tabId: await tabId() });   // hide the current panel now
});
$('useImage').addEventListener('change', e => chrome.storage.local.set({ useImage: e.target.checked }));
$('savePng').addEventListener('change', e => chrome.storage.local.set({ savePng: e.target.checked }));
$('highlight').addEventListener('change', e => chrome.storage.local.set({ highlight: e.target.checked }));
$('autoClick').addEventListener('change', e => chrome.storage.local.set({ autoClick: e.target.checked }));

$('solve').addEventListener('click', async () => {
  setStatus('Reading the current question…');
  const r = await send({ type: 'solve', scope: 'current', tabId: await tabId() });
  if (r) setStatus(r.error ? 'Error: ' + r.error : r.summary);
});
$('solveAll').addEventListener('click', async () => {
  setStatus('Reading the page…');
  const r = await send({ type: 'solve', scope: 'all', tabId: await tabId() });
  if (r) setStatus(r.error ? 'Error: ' + r.error : r.summary);
});
$('reset').addEventListener('click', async () => { await send({ type: 'reset', tabId: await tabId() }); setStatus('New session started.'); });
$('clear').addEventListener('click', async () => { await send({ type: 'clear', tabId: await tabId() }); setStatus('Panel cleared.'); });
$('opts').addEventListener('click', e => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

chrome.runtime.onMessage.addListener(msg => { if (msg.type === 'progress') setStatus(msg.text); });
init();
