// Tests for player/read-along.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const R = require('../player/read-along.js');

// "Chapter 1." / blank line / two sentences, as the voice-clone tool writes it.
const TEXT = 'Chapter 1.\n\nAlice was tired. Then a Rabbit ran by.';
const FILE = {
  version: 1,
  text: TEXT,
  sentences: [[0, 10, 0], [12, 28, 1.5], [29, 49, 4]],
  words: [[0, 7, 0], [8, 9, 0.6], [12, 17, 1.5], [18, 21, 1.9], [22, 27, 2.1], [29, 33, 4], [34, 35, 4.3], [36, 42, 4.4], [43, 46, 4.9], [46, 49, 5.2]],
};

test('finds the sentence and word being spoken', () => {
  const m = R.prepare(FILE);
  assert.strictEqual(R.indexAt(m.sentences, 0.2), 0);
  assert.strictEqual(R.indexAt(m.sentences, 3.9), 1);
  assert.strictEqual(R.indexAt(m.sentences, 99), 2);
  assert.strictEqual(R.indexAt(m.words, 2.0), 3);
  assert.strictEqual(TEXT.slice(m.words[3].start, m.words[3].end), 'was');
  assert.strictEqual(R.indexAt(m.words, -1), -1);
});

test('spreads a sentence over its words when the file has no word times', () => {
  const m = R.prepare({ ...FILE, words: [] }, 8);
  const words = m.words.map(w => TEXT.slice(w.start, w.end));
  assert.deepStrictEqual(words, ['Chapter', '1', 'Alice', 'was', 'tired', 'Then', 'a', 'Rabbit', 'ran', 'by']);
  assert.strictEqual(m.words[2].time, 1.5); // first word starts with its sentence
  for (let i = 1; i < m.words.length; i++) assert.ok(m.words[i].time >= m.words[i - 1].time);
  assert.ok(m.words[4].time < 4); // and words stay inside their sentence
});

test('rejects files it cannot use, and drops broken entries', () => {
  assert.strictEqual(R.prepare(null), null);
  assert.strictEqual(R.prepare({ text: 'x', sentences: [] }), null);
  const m = R.prepare({ ...FILE, sentences: [[0, 10, 0], [5, 2, 1], [0, 999, 2]] });
  assert.strictEqual(m.sentences.length, 1);
});

test('lays the text out in paragraphs, sentences and words', () => {
  const runs = R.runs(R.prepare(FILE));
  assert.strictEqual(runs.map(r => r.paragraph ? '¶' : r.text).join(''), 'Chapter 1.¶Alice was tired. Then a Rabbit ran by.');
  const rabbit = runs.find(r => r.text === 'Rabbit');
  assert.deepStrictEqual([rabbit.start, rabbit.sentence, rabbit.word], [TEXT.indexOf('Rabbit'), 2, 7]);
  const space = runs.find(r => r.text === ' ' && r.sentence === 1);
  assert.strictEqual(space.word, -1);
  assert.strictEqual(runs.filter(r => r.paragraph).length, 1);
});

test('finds the time a character is spoken', () => {
  const m = R.prepare(FILE);
  assert.strictEqual(R.timeOfChar(m, TEXT.indexOf('Rabbit') + 2), 4.4);
  assert.strictEqual(R.timeOfChar(m, TEXT.indexOf(' Then')), 1.5); // a space: its sentence
});

test('searches without caring about capitals, and makes snippets', () => {
  const text = 'The Rabbit ran. A rabbit hole. ' + 'Words go on and on here. '.repeat(4);
  assert.deepStrictEqual(R.find(text, 'RABBIT').map(f => f.start), [4, 18]);
  assert.deepStrictEqual(R.find(text, 'a'), []); // too short to be useful
  const s = R.snippet(text, 18, 24, 10);
  assert.strictEqual(s.match, 'rabbit');
  assert.ok(s.before.startsWith('…') || s.before.startsWith('The'));
  assert.ok(s.after.endsWith('…'));
});
