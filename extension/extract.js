// Runs on the options page. Turns a picked File into stored DB records.
// PDFs are read locally with pdf.js -> text (no size limit, no cost, cached forever).
// A scanned PDF (little text) is kept as bytes so OpenRouter OCR can handle it instead.
(() => {
  let pdfReady = false;
  try {
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdf.worker.min.js');
      pdfReady = true;
    }
  } catch (e) { console.error('pdf.js init failed', e); }

  const stripXml = s => s
    .replace(/<a:p>|<\/a:p>|<\/w:p>|<w:br\/?>|<a:br\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  const pick = (zip, re) => Object.keys(zip).filter(n => re.test(n))
    .sort((a, b) => (parseInt(a.match(/(\d+)/)?.[1] || 0) - parseInt(b.match(/(\d+)/)?.[1] || 0)));

  function fromDocx(u8) {
    const zip = window.fflate.unzipSync(u8);
    const dec = new TextDecoder();
    const names = ['word/document.xml', ...pick(zip, /^word\/(header|footer)\d*\.xml$/)];
    return names.filter(n => zip[n]).map(n => stripXml(dec.decode(zip[n]))).join('\n').trim();
  }
  function fromPptx(u8) {
    const zip = window.fflate.unzipSync(u8);
    const dec = new TextDecoder();
    const slides = pick(zip, /^ppt\/slides\/slide\d+\.xml$/);
    return slides.map((n, i) => `--- slide ${i + 1} ---\n` + stripXml(dec.decode(zip[n]))).join('\n\n').trim();
  }

  async function fromPdf(buf) {
    if (!window.pdfjsLib) throw new Error('pdf.js failed to load (vendor/pdf.min.js). Reload the extension at chrome://extensions.');
    const pdf = await window.pdfjsLib.getDocument({ data: buf, isEvalSupported: false }).promise;
    const out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const text = content.items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
      if (text) out.push(`--- page ${p} ---\n${text}`);
    }
    return { text: out.join('\n\n'), pages: pdf.numPages };
  }

  async function fileToRecord(course, file) {
    const id = `${course}::${file.name}`;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const base = { id, course, name: file.name, addedAt: Date.now() };

    if (ext === 'pdf') {
      const buf = await file.arrayBuffer();
      const { text, pages } = await fromPdf(buf.slice(0));   // pdf.js transfers the buffer; keep a copy
      const perPage = pages ? text.length / pages : text.length;
      if (text.length >= 40 && perPage >= 15) {
        return { ...base, type: 'text', text, chars: text.length, note: `pdf text, ${pages}p` };
      }
      // scanned / image-only PDF: no usable text layer -> keep bytes for OpenRouter OCR
      return { ...base, type: 'pdf', mime: 'application/pdf', data: buf, chars: 0,
               scanned: true, pages };
    }
    if (ext === 'txt' || ext === 'md') {
      const text = await file.text();
      return { ...base, type: 'text', text, chars: text.length };
    }
    if (ext === 'docx') {
      const text = fromDocx(new Uint8Array(await file.arrayBuffer()));
      return { ...base, type: 'text', text, chars: text.length };
    }
    if (ext === 'pptx') {
      const text = fromPptx(new Uint8Array(await file.arrayBuffer()));
      return { ...base, type: 'text', text, chars: text.length };
    }
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
      const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file);
      });
      return { ...base, type: 'image', mime: file.type, dataUrl, chars: 0 };
    }
    throw new Error(`Unsupported file type: .${ext}`);
  }

  window.Extract = { fileToRecord, pdfReady, pdfVersion: (window.pdfjsLib && window.pdfjsLib.version) || null };
})();
