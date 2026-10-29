'use strict';

// Read along: finds which sentence and word of a chapter is being spoken at a given moment, using the
// timing file the voice-clone tool saves next to each chapter ("01 - Chapter One.json"):
//   {"version": 1, "text": "...", "sentences": [[first char, last char + 1, start seconds], ...], "words": [same]}
// Used by reader.js; it is plain functions, so it can also be tested with Node.

const ReadAlong = (() => {
  const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
  const CHARS_PER_SECOND = 15; // typical narration pace, for a last sentence with no end time

  // Checks a timing file and returns { text, sentences, words } with times in seconds, or null if it can't be used.
  // Each sentence and word is { start, end, time }. When the file has no word times, each sentence's time is
  // spread over its words by their length.
  function prepare(data, duration = 0) {
    if (!data || typeof data.text !== 'string' || !Array.isArray(data.sentences) || !data.sentences.length) return null;
    const text = data.text;
    const valid = ([start, end, time]) => Number.isFinite(start) && end > start && end <= text.length && Number.isFinite(time);
    const toItem = ([start, end, time]) => ({ start, end, time });
    const sentences = data.sentences.filter(valid).map(toItem);
    if (!sentences.length) return null;
    const given = Array.isArray(data.words) ? data.words.filter(valid).map(toItem) : [];
    const words = given.length ? given : estimateWords(text, sentences, duration);
    return { text, sentences, words };
  }

  function sentenceEnd(sentences, i, text, duration) {
    if (i + 1 < sentences.length) return sentences[i + 1].time;
    const s = sentences[i];
    const guess = s.time + (s.end - s.start) / CHARS_PER_SECOND;
    return duration > s.time ? Math.min(duration, guess * 2) : guess;
  }

  function estimateWords(text, sentences, duration = 0) {
    const words = [];
    sentences.forEach((s, i) => {
      const end = sentenceEnd(sentences, i, text, duration);
      // Leave the pause before the next sentence out of the speaking time.
      const span = Math.max(0.1, (end - s.time) * 0.9);
      const length = Math.max(1, s.end - s.start);
      for (const m of text.slice(s.start, s.end).matchAll(WORD)) {
        words.push({ start: s.start + m.index, end: s.start + m.index + m[0].length, time: s.time + (span * m.index) / length });
      }
    });
    return words;
  }

  // Index of the last item whose time is at or before `time` (-1 if none yet).
  function indexAt(items, time) {
    let lo = 0;
    let hi = items.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].time <= time) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  // Index of the item whose characters include `char` (or the last one starting before it).
  function indexOfChar(items, char) {
    let lo = 0;
    let hi = items.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].start <= char) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found;
  }

  // The moment a character of the text is spoken: its word's time, or else its sentence's.
  function timeOfChar(model, char) {
    const w = indexOfChar(model.words, char);
    if (w >= 0 && char < model.words[w].end) return model.words[w].time;
    const s = indexOfChar(model.sentences, Math.max(0, char));
    return s >= 0 ? model.sentences[s].time : 0;
  }

  // Splits the text into runs for display: each run is { start, text, sentence, word } (the run's first
  // character, its text, and indexes, -1 for none) or { paragraph: true } where a new paragraph starts.
  function runs(model) {
    const { text, sentences, words } = model;
    const cuts = new Set([0, text.length]);
    for (const item of sentences.concat(words)) {
      cuts.add(item.start);
      cuts.add(item.end);
    }
    for (const m of text.matchAll(/\n\s*\n/g)) {
      cuts.add(m.index);
      cuts.add(m.index + m[0].length);
    }
    const points = [...cuts].filter(c => c >= 0 && c <= text.length).sort((a, b) => a - b);
    const out = [];
    let s = 0;
    let w = 0;
    for (let i = 0; i + 1 < points.length; i++) {
      const start = points[i];
      const piece = text.slice(start, points[i + 1]);
      if (/^\n\s*\n/.test(piece) && !piece.trim()) {
        out.push({ paragraph: true });
        continue;
      }
      while (s < sentences.length && sentences[s].end <= start) s++;
      while (w < words.length && words[w].end <= start) w++;
      out.push({
        start,
        text: piece,
        sentence: s < sentences.length && sentences[s].start <= start ? s : -1,
        word: w < words.length && words[w].start <= start ? w : -1,
      });
    }
    return out;
  }

  // Where `query` appears in `text`, ignoring capitals: a list of { start, end }.
  function find(text, query) {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    const haystack = text.toLowerCase();
    const found = [];
    for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) {
      found.push({ start: at, end: at + needle.length });
    }
    return found;
  }

  // A short piece of text around a match, for search results: "…the White Rabbit with pink eyes ran…".
  function snippet(text, start, end, around = 40) {
    let from = Math.max(0, start - around);
    let to = Math.min(text.length, end + around);
    if (from > 0) from = text.indexOf(' ', from) + 1 || from;
    if (to < text.length) to = text.lastIndexOf(' ', to) > end ? text.lastIndexOf(' ', to) : to;
    const clean = s => s.replace(/\s+/g, ' ');
    return {
      before: (from > 0 ? '…' : '') + clean(text.slice(from, start)),
      match: clean(text.slice(start, end)),
      after: clean(text.slice(end, to)) + (to < text.length ? '…' : ''),
    };
  }

  return { prepare, estimateWords, indexAt, indexOfChar, timeOfChar, runs, find, snippet };
})();

if (typeof module === 'object') module.exports = ReadAlong;
