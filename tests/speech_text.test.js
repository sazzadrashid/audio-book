// Tests for player/speech-text.js. Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const T = require('../player/speech-text.js');

test('rewrites things the voice reads badly', () => {
  const cases = {
    'Mr. Smith met Dr. Jones on St. James Street.': 'Mister Smith met Doctor Jones on Saint James Street.',
    'Revenue grew to $10M.': 'Revenue grew to 10 million dollars.',
    'It cost $2.5 billion.': 'It cost 2.5 billion dollars.',
    'It cost $4.99.': 'It cost 4 dollars and 99 cents.',
    'Revenue was $1,250,000.': 'Revenue was one million two hundred fifty thousand dollars.',
    'Chapter IV begins on p. 23.': 'Chapter 4 begins on page 23.',
    'Use short words, e.g. these.': 'Use short words, for example, these.',
    'Our #1 priority is speed & focus.': 'Our number 1 priority is speed and focus.',
    'He paused—then he spoke.': 'He paused, then he spoke.',
    'We met at 10:05 a.m. on Monday.': 'We met at 10 oh 5 A M on Monday.',
  };
  for (const [input, expected] of Object.entries(cases)) assert.strictEqual(T.normalize(input), expected);
});

test('splits sentences without breaking at initials and abbreviations', () => {
  const sentences = T.splitSentences(T.normalize('Mr. Smith saw J. K. Rowling at 5 p.m. Then he left! The U.S. Acme Inc. agreed.'));
  assert.deepStrictEqual(sentences, ['Mister Smith saw J. K. Rowling at 5 P M.', 'Then he left!', 'The U S.', 'Acme Inc. agreed.']);
});

test('plans pauses by punctuation, paragraphs and headings', () => {
  const pieces = T.plan('Chapter One.\n\nIt was late. Who called?\n\nNobody answered...', { title: 'Chapter One', random: () => 0.5 });
  // The heading is said with the first sentence, with a longer break between them.
  assert.deepStrictEqual(pieces.map(p => p.text), ['Chapter One. It was late.', 'Who called?', 'Nobody answered,']);
  assert.strictEqual(pieces[0].headingBreak, T.PAUSES.heading);
  const [sentence, lastInParagraph, ellipsis] = pieces.map(p => p.pause);
  assert.strictEqual(sentence, T.PAUSES.sentence);
  assert.strictEqual(lastInParagraph, T.PAUSES.paragraph);
  assert.ok(ellipsis >= T.PAUSES.paragraph);
  assert.ok(pieces.every(p => p.pace > 0.9 && p.pace < 1.2));
  const chars = pieces.reduce((sum, p) => sum + p.chars, 0); // used for progress, so rounding is fine
  assert.ok(Math.abs(chars - 'Chapter One.\n\nIt was late. Who called?\n\nNobody answered...'.length) <= pieces.length);
});

test('breaks very long sentences at clauses', () => {
  const long = Array(30).fill('this goes on, and on').join(', ') + '.';
  const parts = T.splitLong(long);
  assert.ok(parts.length > 1 && parts.every(p => p.length <= 350));
  assert.strictEqual(parts.join(' '), long);
});
