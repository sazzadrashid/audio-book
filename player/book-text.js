'use strict';

// Reads the text of a PDF, EPUB or TXT book in the browser and splits it into chapters.
// Same rules as converter/audiobook.py.

const BookText = (() => {
  const MIN_CHAPTER_CHARS = 200; // shorter sections (title pages, contents entries) are skipped
  const PART_WORDS = 4000; // books without chapter headings are split into parts of about this many words

  const NUMBER_WORDS =
    'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|' +
    'fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty';
  const NUMBER = `(?:\\d+|[ivxlcdm]+|(?:${NUMBER_WORDS})(?:[- ](?:${NUMBER_WORDS}))?)`;
  const HEADING_RE = new RegExp(
    `^(?:(?:chapter|part|book)\\s+${NUMBER}\\b[.:]?(?:\\s.{0,70})?` +
      '|(?:prologue|epilogue|introduction|preface|foreword|afterword)[.:]?)$',
    'i',
  );
  const ROMAN_RE = /^[IVXLCDM]+\.?$/i;
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'LI', 'TR', 'PRE',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DT', 'DD', 'FIGCAPTION',
  ]);

  class BookError extends Error {}

  // ---------- Text helpers ----------

  function cleanText(text) {
    text = text.normalize('NFC').replace(/\r\n?/g, '\n');
    text = text.replace(/­/g, ''); // soft hyphens
    text = text.replace(/(\w)-\n(\w)/g, '$1$2'); // words split across lines
    text = text.replace(/[ \t  ​]+/g, ' ');
    text = text.replace(/ *\n */g, '\n');
    text = text.replace(/^\d{1,4}(?:\n|$)/gm, ''); // lone page numbers
    return text
      .split(/\n{2,}/)
      .map(p => p.split('\n').join(' ').trim()) // lines inside a paragraph are joined
      .filter(Boolean)
      .join('\n\n');
  }

  function niceTitle(line) {
    line = line.split(/\s+/).join(' ').replace(/^[\s.:-]+|[\s.:-]+$/g, '');
    if (line !== line.toUpperCase() || line === line.toLowerCase()) return line;
    return line
      .split(' ')
      .map(w => (ROMAN_RE.test(w) ? w.toUpperCase() : w.charAt(0) + w.slice(1).toLowerCase()))
      .join(' ');
  }

  function stripGutenberg(text) {
    const start = text.match(/^\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG.*$/im);
    if (start) text = text.slice(start.index + start[0].length);
    const end = text.match(/^\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG.*$/im);
    if (end) text = text.slice(0, end.index);
    return text;
  }

  function isHeading(lines, i) {
    const line = lines[i].trim();
    if (!line || line.split(/\s+/).length > 12) return false;
    if (i > 0 && lines[i - 1].trim()) return false; // headings follow an empty line
    return HEADING_RE.test(line);
  }

  function wordCount(text) {
    return (text.match(/\S+/g) || []).length;
  }

  function splitIntoChapters(text) {
    const lines = text.normalize('NFC').replace(/\r\n?/g, '\n').split('\n');
    const starts = [];
    lines.forEach((_, i) => isHeading(lines, i) && starts.push(i));

    if (starts.length >= 2) {
      const chapters = [];
      if (starts[0] > 0) {
        const opening = cleanText(lines.slice(0, starts[0]).join('\n'));
        if (opening.length >= MIN_CHAPTER_CHARS) chapters.push({ title: 'Opening', text: opening });
      }
      starts.forEach((start, n) => {
        const end = n + 1 < starts.length ? starts[n + 1] : lines.length;
        const title = niceTitle(lines[start]);
        const body = cleanText(lines.slice(start + 1, end).join('\n'));
        if (body.length >= MIN_CHAPTER_CHARS) chapters.push({ title, text: `${title}.\n\n${body}` });
      });
      if (chapters.length) return chapters;
    }
    return splitIntoParts(cleanText(text));
  }

  function splitIntoParts(text, partWords = PART_WORDS) {
    const pieces = [];
    for (const paragraph of text.split('\n\n')) {
      if (wordCount(paragraph) > partWords) pieces.push(...paragraph.split(/(?<=[.!?])\s+/));
      else pieces.push(paragraph);
    }
    const parts = [[]];
    let count = 0;
    for (const piece of pieces) {
      const words = wordCount(piece);
      if (count && count + words > partWords) {
        parts.push([]);
        count = 0;
      }
      parts[parts.length - 1].push(piece);
      count += words;
    }
    const texts = parts.map(p => p.join('\n\n').trim()).filter(Boolean);
    if (texts.length === 1) return [{ title: 'Full book', text: texts[0] }];
    return texts.map((text, n) => ({ title: `Part ${n + 1}`, text }));
  }

  function fileStem(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  }

  // ---------- TXT ----------

  async function readTxt(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      text = new TextDecoder('windows-1252').decode(bytes);
    }
    text = text.replace(/^﻿/, '');
    const head = text.slice(0, 5000);
    const title = head.match(/^Title:\s*(.+)$/m)?.[1].trim() || fileStem(file.name);
    const author = head.match(/^Author:\s*(.+)$/m)?.[1].trim() || '';
    return { title, author, chapters: splitIntoChapters(stripGutenberg(text)), cover: null };
  }

  // ---------- PDF ----------

  async function readPdf(file) {
    const pdfjs = await import('./vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdfjs/pdf.worker.min.mjs', location.href).href;
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
    } catch (err) {
      if (err?.name === 'PasswordException') throw new BookError('This PDF is password-protected.');
      throw new BookError('This PDF could not be opened. It may be damaged.');
    }

    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(pageText(content.items));
      page.cleanup();
    }
    if (!pages.join('').trim()) {
      throw new BookError(
        'This PDF has no text to read. It is probably scanned pages (pictures of text). Try an EPUB or text version of the book.',
      );
    }

    const meta = await doc.getMetadata().catch(() => null);
    const title = meta?.info?.Title?.trim() || fileStem(file.name);
    const author = meta?.info?.Author?.trim() || '';
    let chapters = await chaptersFromOutline(doc, pages);
    if (!chapters.length) chapters = splitIntoChapters(pages.join('\n\n'));
    doc.destroy();
    return { title, author, chapters, cover: null };
  }

  // Rebuild lines and paragraphs from positioned PDF text.
  function pageText(items) {
    let text = '';
    let lastY = null;
    for (const item of items) {
      if (!('str' in item)) continue;
      const y = item.transform[5];
      const fontSize = item.height || Math.abs(item.transform[3]) || 10;
      // Lines are normally about 1.2 font sizes apart; a bigger gap starts a new paragraph.
      if (lastY !== null && text.endsWith('\n') && lastY - y > fontSize * 1.8) text += '\n';
      text += item.str;
      if (item.hasEOL) text += '\n';
      if (item.str.trim()) lastY = y;
    }
    return text;
  }

  async function chaptersFromOutline(doc, pages) {
    let marks = [];
    try {
      const outline = (await doc.getOutline()) || [];
      for (const item of outline) {
        const dest = typeof item.dest === 'string' ? await doc.getDestination(item.dest) : item.dest;
        if (!Array.isArray(dest)) continue;
        const page = typeof dest[0] === 'number' ? dest[0] : await doc.getPageIndex(dest[0]);
        marks.push([page, item.title]);
      }
    } catch {
      return [];
    }
    const byPage = new Map(marks);
    marks = [...byPage.entries()].sort((a, b) => a[0] - b[0]);
    if (marks.length < 2) return [];

    const chapters = [];
    if (marks[0][0] > 0) {
      const opening = cleanText(pages.slice(0, marks[0][0]).join('\n\n'));
      if (opening.length >= MIN_CHAPTER_CHARS) chapters.push({ title: 'Opening', text: opening });
    }
    marks.forEach(([page, title], n) => {
      const end = n + 1 < marks.length ? marks[n + 1][0] : pages.length;
      const text = cleanText(pages.slice(page, end).join('\n\n'));
      if (text.length >= MIN_CHAPTER_CHARS) chapters.push({ title: niceTitle(title), text });
    });
    return chapters;
  }

  // ---------- EPUB ----------

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    return doc.querySelector('parsererror') ? new DOMParser().parseFromString(text, 'text/html') : doc;
  }

  function resolvePath(base, href) {
    const parts = (base ? `${base}/` : '').concat(decodeURIComponent(href.split('#')[0])).split('/');
    const out = [];
    for (const part of parts) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return out.join('/');
  }

  function byTag(node, name) {
    return [...node.getElementsByTagNameNS('*', name)];
  }

  function htmlToText(doc) {
    const body = doc.body || doc.documentElement;
    body.querySelectorAll('script, style, nav').forEach(el => el.remove());
    body.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    for (const el of body.querySelectorAll('*')) {
      if (BLOCK_TAGS.has(el.tagName.toUpperCase())) el.after('\n\n');
    }
    return cleanText(body.textContent);
  }

  async function readEpub(file) {
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch {
      throw new BookError('This EPUB file could not be opened. It may be damaged.');
    }
    if (zip.file('META-INF/encryption.xml')) {
      const enc = await zip.file('META-INF/encryption.xml').async('text');
      if (/EncryptedData/.test(enc) && !/obfuscation/i.test(enc)) {
        throw new BookError('This EPUB is copy-protected (DRM), so its text can’t be read.');
      }
    }
    const container = zip.file('META-INF/container.xml');
    if (!container) throw new BookError('This doesn’t look like a valid EPUB file.');
    const opfPath = byTag(parseXml(await container.async('text')), 'rootfile')[0]?.getAttribute('full-path');
    if (!opfPath || !zip.file(opfPath)) throw new BookError('This doesn’t look like a valid EPUB file.');
    const opf = parseXml(await zip.file(opfPath).async('text'));
    const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

    const manifest = new Map();
    for (const item of byTag(opf, 'item')) {
      manifest.set(item.getAttribute('id'), {
        path: resolvePath(base, item.getAttribute('href') || ''),
        type: item.getAttribute('media-type') || '',
        properties: item.getAttribute('properties') || '',
      });
    }

    const title = byTag(opf, 'title')[0]?.textContent.trim() || fileStem(file.name);
    const author = byTag(opf, 'creator')[0]?.textContent.trim() || '';

    // Chapter names from the table of contents (EPUB 3 nav, or EPUB 2 NCX).
    const tocTitles = new Map();
    const nav = [...manifest.values()].find(m => m.properties.split(' ').includes('nav'));
    if (nav && zip.file(nav.path)) {
      const navDoc = parseXml(await zip.file(nav.path).async('text'));
      const navBase = nav.path.includes('/') ? nav.path.slice(0, nav.path.lastIndexOf('/')) : '';
      const tocNav = byTag(navDoc, 'nav').find(n => /toc/.test(n.getAttribute('epub:type') || n.getAttribute('type') || '')) ||
        byTag(navDoc, 'nav')[0];
      for (const a of tocNav ? byTag(tocNav, 'a') : []) {
        const path = resolvePath(navBase, a.getAttribute('href') || '');
        if (!tocTitles.has(path)) tocTitles.set(path, a.textContent.trim());
      }
    }
    const ncxId = byTag(opf, 'spine')[0]?.getAttribute('toc');
    const ncx = manifest.get(ncxId);
    if (!tocTitles.size && ncx && zip.file(ncx.path)) {
      const ncxDoc = parseXml(await zip.file(ncx.path).async('text'));
      const ncxBase = ncx.path.includes('/') ? ncx.path.slice(0, ncx.path.lastIndexOf('/')) : '';
      for (const point of byTag(ncxDoc, 'navPoint')) {
        const label = byTag(point, 'text')[0]?.textContent.trim();
        const src = byTag(point, 'content')[0]?.getAttribute('src');
        if (label && src) {
          const path = resolvePath(ncxBase, src);
          if (!tocTitles.has(path)) tocTitles.set(path, label);
        }
      }
    }

    const chapters = [];
    for (const ref of byTag(opf, 'itemref')) {
      const item = manifest.get(ref.getAttribute('idref'));
      if (!item || !/html/.test(item.type) || !zip.file(item.path)) continue;
      const doc = parseXml(await zip.file(item.path).async('text'));
      const heading = (doc.body || doc.documentElement).querySelector('h1, h2, h3')?.textContent.trim();
      const text = htmlToText(doc);
      if (text.length < MIN_CHAPTER_CHARS) continue;
      const name = tocTitles.get(item.path) || heading || `Section ${chapters.length + 1}`;
      chapters.push({ title: niceTitle(name), text });
    }

    let cover = null;
    const metaCover = byTag(opf, 'meta').find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
    const coverItem =
      [...manifest.values()].find(m => m.properties.split(' ').includes('cover-image')) ||
      manifest.get(metaCover) ||
      [...manifest.values()].find(m => m.type.startsWith('image/') && /cover/i.test(m.path));
    if (coverItem?.type.startsWith('image/') && zip.file(coverItem.path)) {
      cover = new Blob([await zip.file(coverItem.path).async('uint8array')], { type: coverItem.type });
    }

    return { title, author, chapters, cover };
  }

  // ---------- Entry point ----------

  async function read(file) {
    const name = file.name.toLowerCase();
    let book;
    if (name.endsWith('.pdf') || file.type === 'application/pdf') book = await readPdf(file);
    else if (name.endsWith('.epub') || file.type === 'application/epub+zip') book = await readEpub(file);
    else if (/\.(txt|text|md)$/.test(name) || file.type.startsWith('text/')) book = await readTxt(file);
    else throw new BookError('Please choose a PDF, EPUB or TXT file.');
    if (!book.chapters.length) throw new BookError('No readable text was found in this book.');
    return book;
  }

  return { read, wordCount, cleanText, splitIntoChapters, BookError };
})();
