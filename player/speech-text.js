'use strict';

// Prepares book text for the voice: rewrites things the voice reads badly ("$10M", "Chapter IV",
// "U.S.", "10:30 a.m."…) into plain words, and plans the delivery: one sentence at a time, with
// pauses that depend on the punctuation and small natural changes in pace.
// Used by tts-worker.js; it is plain functions, so it can also be tested with Node.

const SpeechText = (() => {
  // Seconds of silence after each kind of break, at normal speed. They vary by ±15% each time.
  const PAUSES = {
    sentence: 0.42,
    question: 0.5, // also "!"
    ellipsis: 0.6,
    clause: 0.3, // ";" ":" and long sentences split at a comma
    paragraph: 0.85,
    heading: 1.1,
  };
  const MAX_SENTENCE_CHARS = 350; // longer sentences are split at a clause
  // Marks a sentence end that normalize() found, where the letters left behind ("U S", "P M")
  // would otherwise look like initials ("J. K. Rowling") and not end the sentence.
  const END = '\u2063';
  const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  const UNITS = { k: 'thousand', m: 'million', mn: 'million', b: 'billion', bn: 'billion', t: 'trillion', tn: 'trillion' };
  const CURRENCIES = { $: ['dollars', 'cents'], '£': ['pounds', 'pence'], '€': ['euros', 'cents'] };
  // Abbreviations that end with a dot but don't end a sentence.
  const NO_BREAK = new Set(['inc', 'ltd', 'co', 'corp', 'gen', 'col', 'capt', 'lt', 'sgt', 'rev', 'hon', 'mt', 'ave', 'fig', 'vol', 'approx', 'dept', 'est', 'jan', 'feb', 'aug', 'sept', 'oct', 'nov', 'dec']);

  function romanToNumber(text) {
    let total = 0;
    for (let i = 0; i < text.length; i++) {
      const value = ROMAN[text[i]];
      const next = ROMAN[text[i + 1]] || 0;
      total += value < next ? -value : value;
    }
    return total;
  }

  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const SCALES = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];

  // 1250000 -> "one million two hundred fifty thousand". The voice reads long digit runs badly.
  function numberToWords(n) {
    if (n < 20) return ONES[n];
    if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : '');
    if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
    for (const [size, name] of SCALES) {
      if (n >= size) {
        const rest = n % size;
        return `${numberToWords(Math.floor(n / size))} ${name}${rest ? ` ${numberToWords(rest)}` : ''}`;
      }
    }
    return String(n);
  }

  function money(symbol, amount, unit) {
    const [main, small] = CURRENCIES[symbol];
    amount = amount.replace(/,/g, '');
    if (unit) return `${amount} ${UNITS[unit.toLowerCase()] || unit.toLowerCase()} ${main}`;
    const [whole, cents] = amount.split('.');
    if (cents && cents.length === 2 && Number(cents)) return `${whole} ${main} and ${Number(cents)} ${small}`;
    return `${amount} ${main}`;
  }

  // Rewrite things the voice reads badly into plain words.
  function normalize(text) {
    return text
      .replace(/[‘’ʼ]/g, "'")
      .replace(/\s*[—–]\s*|\s+-{1,2}\s+/g, ', ') // dashes: a short spoken break
      .replace(/\.{3,}|…/g, '…')
      .replace(/\bMrs\.(?=\s)/g, 'Missus')
      .replace(/\bMr\.(?=\s)/g, 'Mister')
      .replace(/\bMs\.(?=\s)/g, 'Miz')
      .replace(/\bDr\.(?=\s)/g, 'Doctor')
      .replace(/\bProf\.(?=\s)/g, 'Professor')
      .replace(/\bSt\.(?=\s+[A-Z])/g, 'Saint')
      .replace(/\bSt\.(?=[\s,;:]|$)/g, 'Street')
      .replace(/\bJr\.(?=[\s,;:]|$)/g, 'Junior')
      .replace(/\be\.g\.,?/gi, 'for example,')
      .replace(/\bi\.e\.,?/gi, 'that is,')
      .replace(/\betc\.(?=\s+[a-z,;:])/g, 'et cetera')
      .replace(/\betc\./g, 'et cetera.')
      .replace(/\bvs\.?(?=\s)/gi, 'versus')
      .replace(/\b(?:No|Nos)\.\s?(?=\d)/g, 'number ')
      .replace(/\bpp\.\s?(?=\d)/g, 'pages ')
      .replace(/\bp\.\s?(?=\d)/g, 'page ')
      .replace(/#\s?(?=\d)/g, 'number ')
      .replace(/\b(Chapter|Part|Book|Volume|Section|Act|Scene)\s+([IVXLCDM]+)\b/g, (_, word, roman) => `${word} ${romanToNumber(roman)}`)
      .replace(/\b([aApP])\.\s?[mM]\.(?=(\s+[A-Z])?)/g, (_, x, next) => `${x.toUpperCase()} M${next ? `.${END}` : ''}`)
      .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => (m === '00' ? `${h} o'clock` : m[0] === '0' ? `${h} oh ${m[1]}` : `${h} ${m}`))
      .replace(/([$£€])\s?(\d[\d,]*(?:\.\d+)?)(?:\s?(thousand|million|billion|trillion|bn|mn|tn|[KMBT])\b)?/gi,
        (_, symbol, amount, unit) => money(symbol, amount, unit))
      .replace(/\b\d{1,3}(?:,\d{3})+\b|\b\d{5,15}\b/g, n => numberToWords(Number(n.replace(/,/g, ''))))
      .replace(/\b((?:[A-Z]\.){2,})(?=(\s+[A-Z])?)/g, (_, letters, next) => `${letters.replace(/\./g, ' ').trim()}${next ? `.${END}` : ''}`)
      .replace(/\b1\/2\b/g, 'a half')
      .replace(/\b1\/4\b/g, 'a quarter')
      .replace(/\b3\/4\b/g, 'three quarters')
      .replace(/\b1\/3\b/g, 'a third')
      .replace(/\b2\/3\b/g, 'two thirds')
      .replace(/\s&\s/g, ' and ')
      .replace(/[*_~^|<>{}\[\]\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Split a paragraph into sentences without breaking at initials ("J. K. Rowling") or abbreviations.
  function splitSentences(paragraph) {
    if (paragraph.includes(END)) return paragraph.split(END).flatMap(part => splitSentences(part.trim()));
    const sentences = [];
    const end = /([.!?…]+["'”’)\]]*)\s+/g;
    let start = 0;
    let match;
    while ((match = end.exec(paragraph))) {
      const before = paragraph.slice(start, match.index);
      const word = before.split(/\s+/).pop().toLowerCase();
      const next = paragraph[end.lastIndex] || '';
      if (match[1] === '.' && (/^[a-z]$/i.test(word) || NO_BREAK.has(word))) continue;
      // An ellipsis before a lowercase word is a pause inside the sentence ("Wait… what?").
      if (!/[A-Z0-9"'“‘(\[]/.test(next) && !match[1].startsWith('…')) continue;
      sentences.push(paragraph.slice(start, match.index + match[1].length).trim());
      start = end.lastIndex;
    }
    const rest = paragraph.slice(start).trim();
    if (rest) sentences.push(rest);
    return sentences;
  }

  // Break a very long sentence at clauses so the voice doesn't run out of breath.
  function splitLong(sentence) {
    if (sentence.length <= MAX_SENTENCE_CHARS) return [sentence];
    const parts = [];
    let rest = sentence;
    while (rest.length > MAX_SENTENCE_CHARS) {
      const window = rest.slice(0, MAX_SENTENCE_CHARS);
      let cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(': '));
      if (cut < MAX_SENTENCE_CHARS / 3) cut = window.lastIndexOf(', ');
      if (cut < MAX_SENTENCE_CHARS / 3) cut = window.lastIndexOf(' ');
      if (cut < 1) cut = MAX_SENTENCE_CHARS - 1;
      parts.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  }

  function pauseFor(text) {
    const end = text.replace(/["'”’)\]]+$/, '');
    if (/…$/.test(end)) return PAUSES.ellipsis;
    if (/[?!]$/.test(end)) return PAUSES.question;
    if (/[.]$/.test(end)) return PAUSES.sentence;
    return PAUSES.clause;
  }

  // A short line with no sentence punctuation, like "Chapter 3" or "The Long Night".
  function isHeading(paragraph, title) {
    if (title && paragraph.replace(/[.\s]+$/, '').toLowerCase() === title.replace(/[.\s]+$/, '').toLowerCase()) return true;
    return paragraph.split(/\s+/).length <= 10 && !/[.!?,;:…"'”’]$/.test(paragraph) && /^[A-Z0-9]/.test(paragraph);
  }

  // Plan how to read a chapter: pieces of { text, pause (seconds), pace (1 = normal, higher = slower), chars }.
  // A heading is said together with the sentence after it, because on its own the voices mumble it
  // ("Chapter One" alone came out garbled for several voices); headingBreak then asks for a longer
  // pause at the gap after the heading. random() can be replaced for tests.
  function plan(text, { title = '', random = Math.random } = {}) {
    const vary = () => 0.85 + random() * 0.3;
    const pieces = [];
    let heading = null;
    const push = piece => {
      if (heading) {
        piece.text = `${heading} ${piece.text}`;
        piece.headingBreak = PAUSES.heading * vary();
        piece.headingChars = heading.length;
        heading = null;
      }
      pieces.push(piece);
    };
    for (const raw of text.split(/\n{2,}/)) {
      const paragraph = normalize(raw.replace(/\s+/g, ' ').trim());
      if (!paragraph) continue;
      if (isHeading(paragraph, title)) {
        const words = `${paragraph.replace(/[.\s]+$/, '')}.`;
        heading = heading ? `${heading} ${words}` : words;
        continue;
      }
      const sentences = splitSentences(paragraph).flatMap(splitLong);
      sentences.forEach((sentence, i) => {
        let speak = sentence;
        let pause = pauseFor(sentence);
        // A sentence-ending ellipsis is spoken like a comma, so the voice trails off instead of stopping.
        if (/…["'”’)\]]*$/.test(speak)) speak = speak.replace(/…/, ',');
        speak = speak.replace(/…/g, ',');
        const words = speak.split(/\s+/).length;
        let pace = 0.97 + random() * 0.06; // small changes from sentence to sentence, like a reader
        if (words <= 4) pace += 0.05; // short sentences land a little slower
        const last = i === sentences.length - 1;
        if (last) {
          pause = Math.max(pause, PAUSES.paragraph);
          pace += 0.02;
        }
        if (/[a-z0-9]/i.test(speak)) push({ text: speak, pause: pause * vary(), pace });
      });
    }
    if (heading) pieces.push({ text: heading.replace(/\.$/, ','), pause: PAUSES.heading * vary(), pace: 1 });
    // Spread the original length over the pieces, so progress can be shown in characters of the book.
    const total = pieces.reduce((sum, p) => sum + p.text.length, 0) || 1;
    for (const p of pieces) p.chars = Math.round((text.length * p.text.length) / total);
    return pieces;
  }

  return { normalize, numberToWords, splitSentences, splitLong, plan, PAUSES };
})();

if (typeof module === 'object') module.exports = SpeechText;
