'use strict';

// The "Read along" view: shows the chapter's text and highlights the sentence and word being spoken.
// Timing comes from ReadAlong (read-along.js); the audio, the open book and bookmarks live in app.js,
// which calls Reader.show() when a chapter loads and Reader.sync() as it plays.

const Reader = (() => {
  const SETTINGS_KEY = 'audio-book.reader';
  const DEFAULTS = { size: 1.2, spacing: 1.75, font: 'sans', theme: 'auto' };
  const FOLLOW_AT = 0.35; // keep the sentence being read this far down the text area
  const el = id => document.getElementById(id);

  let settings = loadSettings();
  let model = null; // the open chapter: { text, sentences, words }
  let sentenceSpans = []; // the spans of each sentence (a sentence can be split by a word or a line)
  let wordSpans = [];
  let nowSentence = -1;
  let nowWord = -1;
  let following = true;
  let ourScrollUntil = 0; // scrolls before this moment were made by the reader, not the listener
  let frame = 0;
  let searchToken = 0;

  // ---------- Text settings ----------

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  }

  function applySettings() {
    const reader = el('reader');
    reader.style.setProperty('--reader-size', `${settings.size}rem`);
    reader.style.setProperty('--reader-spacing', settings.spacing);
    reader.dataset.font = settings.font;
    reader.dataset.theme = settings.theme;
    el('size-value').textContent = `${Math.round(settings.size * 100 / DEFAULTS.size)}%`;
    for (const group of el('text-settings').querySelectorAll('[data-setting]')) {
      for (const btn of group.querySelectorAll('button')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.value === String(settings[group.dataset.setting])));
      }
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing: the settings just aren't remembered.
    }
  }

  function changeSetting(name, value) {
    settings[name] = value;
    applySettings();
    if (following) placeCurrent(false);
  }

  // ---------- Showing a chapter ----------

  // data: the chapter's timing file (or null). duration: the chapter's length in seconds.
  function show(data, duration, title) {
    model = data ? ReadAlong.prepare(data, duration) : null;
    el('reader-chapter').textContent = title || '';
    nowSentence = nowWord = -1;
    sentenceSpans = [];
    wordSpans = [];
    hideQuoteButton();
    const box = el('reader-text');
    box.replaceChildren();
    if (!model) {
      const note = document.createElement('div');
      note.className = 'reader-empty';
      note.innerHTML =
        '<p><strong>No text for this chapter.</strong></p>' +
        '<p>Audiobooks made with the voice-clone tool include the text of every chapter, so you can read along. ' +
        'Books made before that, or audio from elsewhere, can only be listened to.</p>';
      box.append(note);
      return;
    }
    render(box);
    following = true;
    el('follow').hidden = true;
    sync(chapterTime(), true);
  }

  function render(box) {
    const fragment = document.createDocumentFragment();
    let paragraph = null;
    let first = true;
    const newParagraph = () => {
      paragraph = document.createElement('p');
      fragment.append(paragraph);
    };
    newParagraph();
    for (const run of ReadAlong.runs(model)) {
      if (run.paragraph) {
        if (first && paragraph.textContent.length < 80) paragraph.classList.add('heading');
        first = false;
        newParagraph();
        continue;
      }
      const span = document.createElement('span');
      span.textContent = run.text;
      span.dataset.c = run.start; // so a click or a selection can be turned into a time
      if (run.sentence >= 0) {
        span.dataset.s = run.sentence;
        (sentenceSpans[run.sentence] ||= []).push(span);
      }
      if (run.word >= 0) {
        span.className = 'w';
        span.dataset.w = run.word;
        wordSpans[run.word] = span;
      }
      paragraph.append(span);
    }
    box.append(fragment);
  }

  // ---------- Following the audio ----------

  // Highlights what is being said at `time` (seconds into the chapter). jump: scroll there at once.
  function sync(time, jump = false) {
    if (!model) return;
    const s = ReadAlong.indexAt(model.sentences, time + 0.05);
    const w = ReadAlong.indexAt(model.words, time + 0.02);
    if (s !== nowSentence) {
      for (const span of sentenceSpans[nowSentence] || []) span.classList.remove('now');
      for (const span of sentenceSpans[s] || []) span.classList.add('now');
      nowSentence = s;
    }
    if (w !== nowWord) {
      wordSpans[nowWord]?.classList.remove('said');
      wordSpans[w]?.classList.add('said');
      nowWord = w;
    }
    if (following) placeCurrent(!jump);
    else el('follow').hidden = isVisible(currentSpan());
  }

  function currentSpan() {
    return wordSpans[nowWord] || sentenceSpans[nowSentence]?.[0] || null;
  }

  function isVisible(span) {
    if (!span) return true;
    const scroller = el('reader-scroll');
    const top = span.offsetTop - scroller.scrollTop;
    return top > 0 && top + span.offsetHeight < scroller.clientHeight;
  }

  // Scrolls so the sentence being read sits near the top third, unless it's already comfortably in view.
  function placeCurrent(smooth) {
    const span = sentenceSpans[nowSentence]?.[0];
    const word = currentSpan();
    if (!span || el('reader').hidden) return;
    const scroller = el('reader-scroll');
    const view = scroller.clientHeight;
    const wordTop = word ? word.offsetTop - scroller.scrollTop : 0;
    const sentenceTop = span.offsetTop - scroller.scrollTop;
    const comfortable = sentenceTop >= 0 && wordTop >= view * 0.1 && wordTop <= view * 0.7;
    if (comfortable) return;
    // A sentence taller than the view: follow the word instead of the sentence's start.
    const anchor = sentenceTop < 0 || span.offsetHeight > view * 0.6 ? word || span : span;
    ourScrollUntil = performance.now() + (smooth ? 900 : 150);
    scroller.scrollTo({ top: Math.max(0, anchor.offsetTop - view * FOLLOW_AT), behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
  }

  function reduceMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function loop() {
    cancelAnimationFrame(frame);
    const tick = () => {
      if (audio.paused || !model || el('reader').hidden) return;
      sync(chapterTime()); // seconds into the chapter (app.js)
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
  }

  function follow() {
    following = true;
    el('follow').hidden = true;
    placeCurrent(true);
  }

  // ---------- Clicking, selecting, quotes ----------

  // The character of the chapter text at a selection boundary (a text node and offset, or an element
  // and child index when the selection starts at the edge of a paragraph).
  function charOf(node, offset) {
    if (node.nodeType === Node.TEXT_NODE) {
      const span = node.parentElement?.closest('[data-c]');
      return span ? Number(span.dataset.c) + offset : -1;
    }
    let child = node.childNodes[offset] || node;
    while (child) {
      const span = child.matches?.('[data-c]') ? child : child.querySelector?.('[data-c]');
      if (span) return Number(span.dataset.c);
      child = child.nextSibling || child.parentElement?.nextElementSibling;
    }
    return -1;
  }

  function onClick(e) {
    const selection = getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return; // selecting a quote
    const span = e.target.closest('[data-c]');
    if (!span || !model) return;
    let time;
    if (span.dataset.w !== undefined) time = model.words[Number(span.dataset.w)].time;
    else if (span.dataset.s !== undefined) time = model.sentences[Number(span.dataset.s)].time;
    else return;
    following = true;
    el('follow').hidden = true;
    seekTo(time);
  }

  function selectedQuote() {
    const selection = getSelection();
    if (!selection || selection.isCollapsed || !model) return null;
    const range = selection.getRangeAt(0);
    if (!el('reader-text').contains(range.commonAncestorContainer)) return null;
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (text.length < 3) return null;
    const start = charOf(range.startContainer, range.startOffset);
    return { text, time: ReadAlong.timeOfChar(model, Math.max(0, start)), rect: range.getBoundingClientRect() };
  }

  function updateQuoteButton() {
    const quote = selectedQuote();
    const btn = el('save-quote');
    if (!quote) {
      hideQuoteButton();
      return;
    }
    btn.hidden = false;
    const width = btn.offsetWidth;
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, quote.rect.left + quote.rect.width / 2 - width / 2));
    const top = quote.rect.top > 60 ? quote.rect.top - btn.offsetHeight - 8 : quote.rect.bottom + 8;
    btn.style.left = `${left}px`;
    btn.style.top = `${top}px`;
  }

  function hideQuoteButton() {
    el('save-quote').hidden = true;
  }

  async function saveQuote() {
    const quote = selectedQuote();
    if (!quote) return;
    await addMark('quote', quote.time, quote.text);
    getSelection().removeAllRanges();
    hideQuoteButton();
  }

  // ---------- Search ----------

  function toggleSearch(open = el('search-panel').hidden) {
    el('search-panel').hidden = !open;
    el('search-open').setAttribute('aria-expanded', String(open));
    if (open) {
      el('text-settings').hidden = true;
      el('settings-open').setAttribute('aria-expanded', 'false');
      el('search-input').focus();
      el('search-input').select();
    }
  }

  // Searches the text of every chapter of the open book; chapterText(i) loads a chapter's timing file.
  async function search(query) {
    const token = ++searchToken;
    const list = el('search-results');
    const status = el('search-status');
    list.replaceChildren();
    if (query.trim().length < 2) {
      status.textContent = '';
      return;
    }
    status.textContent = 'Searching…';
    let total = 0;
    let withText = 0;
    const limit = 200;
    for (let i = 0; i < current.chapters.length && total < limit; i++) {
      const data = await chapterText(i);
      if (token !== searchToken) return;
      const chapter = data ? ReadAlong.prepare(data, current.chapters[i].duration || 0) : null;
      if (!chapter) continue;
      withText++;
      for (const found of ReadAlong.find(chapter.text, query)) {
        if (total++ >= limit) break;
        const parts = ReadAlong.snippet(chapter.text, found.start, found.end);
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        const where = document.createElement('span');
        where.className = 'muted small';
        where.textContent = current.chapters[i].title;
        const text = document.createElement('span');
        const mark = document.createElement('mark');
        mark.textContent = parts.match;
        text.append(parts.before, mark, parts.after);
        btn.append(where, text);
        const time = ReadAlong.timeOfChar(chapter, found.start);
        btn.addEventListener('click', () => jumpTo(i, time));
        li.append(btn);
        list.append(li);
      }
    }
    if (!withText) status.textContent = 'This book has no text to search.';
    else if (!total) status.textContent = `No matches for “${query.trim()}”.`;
    else status.textContent = total > limit ? `More than ${limit} matches; showing the first ${limit}.` : `${total} match${total === 1 ? '' : 'es'}.`;
  }

  // ---------- Set up ----------

  function setup() {
    applySettings();
    el('reader-text').addEventListener('click', onClick);
    const scroller = el('reader-scroll');
    // Only a scroll that follows the listener's own wheel, touch, key or scrollbar drag means "I'm looking
    // elsewhere"; the text moving because of a new font or size, or our own following, doesn't.
    let handledUntil = 0;
    const listenerScrolls = () => {
      handledUntil = performance.now() + 1000;
      ourScrollUntil = 0;
    };
    for (const type of ['wheel', 'touchmove', 'pointerdown', 'keydown']) {
      scroller.addEventListener(type, listenerScrolls, { passive: true });
    }
    scroller.addEventListener('scroll', () => {
      if (performance.now() < ourScrollUntil || performance.now() > handledUntil) return;
      following = false; // the listener scrolled away to look at something
      el('follow').hidden = isVisible(currentSpan());
      hideQuoteButton();
    }, { passive: true });
    el('follow').addEventListener('click', follow);
    el('save-quote').addEventListener('mousedown', e => e.preventDefault()); // keep the selection
    el('save-quote').addEventListener('click', saveQuote);
    document.addEventListener('selectionchange', () => {
      clearTimeout(setup.selectionTimer);
      setup.selectionTimer = setTimeout(updateQuoteButton, 150);
    });

    el('settings-open').addEventListener('click', () => {
      const open = el('text-settings').hidden;
      el('text-settings').hidden = !open;
      el('settings-open').setAttribute('aria-expanded', String(open));
      if (open) toggleSearch(false);
    });
    for (const btn of el('text-settings').querySelectorAll('[data-size]')) {
      btn.addEventListener('click', () => {
        const size = Math.round((settings.size + Number(btn.dataset.size)) * 10) / 10;
        changeSetting('size', Math.min(2.4, Math.max(0.9, size)));
      });
    }
    for (const group of el('text-settings').querySelectorAll('[data-setting]')) {
      group.addEventListener('click', e => {
        const btn = e.target.closest('button[data-value]');
        if (!btn) return;
        const value = group.dataset.setting === 'spacing' ? Number(btn.dataset.value) : btn.dataset.value;
        changeSetting(group.dataset.setting, value);
      });
    }

    el('search-open').addEventListener('click', () => toggleSearch());
    let searchTimer;
    el('search-input').addEventListener('input', e => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => search(e.target.value), 250);
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || el('reader').hidden) return;
      toggleSearch(false);
      el('text-settings').hidden = true;
      el('settings-open').setAttribute('aria-expanded', 'false');
    });
  }

  // Empties the view while a different book opens.
  function clear() {
    model = null;
    nowSentence = nowWord = -1;
    sentenceSpans = [];
    wordSpans = [];
    el('reader-text').replaceChildren();
    el('reader-chapter').textContent = '';
  }

  return {
    setup,
    show,
    clear,
    sync,
    loop,
    follow,
    toggleSearch,
    hasText: () => Boolean(model),
    // The sentence being read, for bookmarks: "Alice was beginning to get very tired…"
    currentSentence() {
      if (!model || nowSentence < 0) return '';
      const s = model.sentences[nowSentence];
      return model.text.slice(s.start, s.end).replace(/\s+/g, ' ').trim();
    },
  };
})();
