'use strict';

// Turns text into speech with a Piper voice, entirely inside the browser.
//
// Messages in:
//   { type: 'load', model, config }                 load a voice (URLs)
//   { type: 'speak', id, text, speed }              make an MP3 of the text
// Messages out:
//   { type: 'loading', loaded, total }              voice download progress
//   { type: 'ready' }
//   { type: 'progress', id, chars }                 characters finished since the last message
//   { type: 'done', id, mp3, duration }             mp3 is a Blob, duration in seconds
//   { type: 'error', id, message }

importScripts('vendor/ort/ort.wasm.min.js', 'vendor/piper/piper_phonemize.js', 'vendor/lame/lame.min.js');

ort.env.wasm.wasmPaths = new URL('vendor/ort/', self.location.href).href;
ort.env.wasm.numThreads = 1; // GitHub Pages can't enable shared memory, so one thread per worker.

const VOICE_CACHE = 'audio-book-voices';
const CHUNK_CHARS = 280; // text is spoken in pieces of about this size
const MAX_CHARS = 400;
const SENTENCE_PAUSE = 0.25; // seconds of silence between pieces
const PARAGRAPH_PAUSE = 0.6;
const MP3_KBPS = 48; // plenty for speech, about 21 MB per hour
// The phonemizer leaks a little memory on every call and crashes after a few dozen, so it is
// restarted (in about 20 ms, from files already in memory) well before that.
const PHONEMIZER_CALLS = 8;
// Piper's speed setting isn't linear: asking for 1.4x gives about 1.27x. Measured pairs of
// [speed you hear, setting needed] (average of two voices), used to hit the speed asked for.
const SPEED_TABLE = [
  [0.46, 0.4], [0.56, 0.5], [0.66, 0.6], [0.75, 0.7], [0.9, 0.85], [1, 1], [1.12, 1.2],
  [1.27, 1.4], [1.5, 1.7], [1.62, 2], [1.81, 2.5], [2.01, 3],
];

function engineSpeed(target) {
  const t = SPEED_TABLE;
  let i = 1;
  while (i < t.length - 1 && target > t[i][0]) i++;
  const [[a0, s0], [a1, s1]] = [t[i - 1], t[i]];
  return s0 + ((target - a0) * (s1 - s0)) / (a1 - a0);
}

let session = null;
let config = null;
let phonemizer = null;
let phonemizerCalls = 0;
let phonemizerFiles = null; // { wasmBinary, data }
const phonemizerOutput = [];

async function fetchWithCache(url, onProgress) {
  const cache = self.caches ? await caches.open(VOICE_CACHE).catch(() => null) : null;
  const cached = cache && (await cache.match(url));
  if (cached) return cached.arrayBuffer();

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${url.split('/').pop()} (error ${res.status}).`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (onProgress) onProgress(loaded, total);
  }
  const blob = new Blob(parts);
  if (cache) await cache.put(url, new Response(blob)).catch(() => {});
  return blob.arrayBuffer();
}

async function loadVoice(modelUrl, configUrl) {
  config = JSON.parse(new TextDecoder().decode(await fetchWithCache(configUrl)));
  const model = await fetchWithCache(modelUrl, (loaded, total) => postMessage({ type: 'loading', loaded, total }));
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  const [wasmBinary, data] = await Promise.all([
    fetch('vendor/piper/piper_phonemize.wasm').then(r => r.arrayBuffer()),
    fetch('vendor/piper/piper_phonemize.data').then(r => r.arrayBuffer()),
  ]);
  phonemizerFiles = { wasmBinary, data };
  await restartPhonemizer();
}

async function restartPhonemizer() {
  phonemizer = await createPiperPhonemize({
    print: line => phonemizerOutput.push(line),
    printErr: () => {},
    wasmBinary: phonemizerFiles.wasmBinary,
    getPreloadedPackage: () => phonemizerFiles.data,
    locateFile: file => new URL(`vendor/piper/${file}`, self.location.href).href,
    noInitialRun: true,
  });
  phonemizerCalls = 0;
}

async function phonemeIds(text) {
  for (let attempt = 1; ; attempt++) {
    if (phonemizerCalls >= PHONEMIZER_CALLS || attempt > 1) await restartPhonemizer();
    phonemizerOutput.length = 0;
    phonemizerCalls++;
    try {
      phonemizer.callMain([
        '-l', config.espeak.voice,
        '--input', JSON.stringify([{ text }]),
        '--espeak_data', '/espeak-ng-data',
      ]);
      const line = phonemizerOutput.pop();
      return line ? JSON.parse(line).phoneme_ids : [];
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

async function synthesize(text, speed) {
  const ids = await phonemeIds(text);
  if (!ids.length) return new Float32Array(0);
  const { noise_scale: noise, length_scale: length, noise_w: noiseW } = config.inference;
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([noise, length / engineSpeed(speed), noiseW]), [3]),
  };
  if (config.num_speakers > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const { output } = await session.run(feeds);
  return output.data;
}

// Split text into pieces the voice can say in one go, preferring sentence ends.
function splitText(text) {
  const pieces = [];
  for (const paragraph of text.split(/\n{2,}/)) {
    const sentences = paragraph.replace(/\s+/g, ' ').match(/[^.!?…।]+(?:[.!?…।]+["'”’)\]]*\s*|$)/g) || [];
    let current = '';
    for (let sentence of sentences) {
      sentence = sentence.trim();
      while (sentence.length > MAX_CHARS) {
        let cut = sentence.lastIndexOf(', ', MAX_CHARS);
        if (cut < MAX_CHARS / 2) cut = sentence.lastIndexOf(' ', MAX_CHARS);
        if (cut < 1) cut = MAX_CHARS;
        if (current) {
          pieces.push({ text: current, pause: SENTENCE_PAUSE });
          current = '';
        }
        pieces.push({ text: sentence.slice(0, cut + 1).trim(), pause: 0.1 });
        sentence = sentence.slice(cut + 1).trim();
      }
      if (!sentence) continue;
      if (current && current.length + sentence.length + 1 > CHUNK_CHARS) {
        pieces.push({ text: current, pause: SENTENCE_PAUSE });
        current = '';
      }
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current) pieces.push({ text: current, pause: PARAGRAPH_PAUSE });
  }
  return pieces;
}

class Mp3Writer {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.encoder = new lamejs.Mp3Encoder(1, sampleRate, MP3_KBPS);
    this.parts = [];
    this.samples = 0;
  }

  write(float32) {
    const pcm = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    for (let i = 0; i < pcm.length; i += 1152) {
      const out = this.encoder.encodeBuffer(pcm.subarray(i, i + 1152));
      if (out.length) this.parts.push(new Uint8Array(out));
    }
    this.samples += pcm.length;
  }

  silence(seconds) {
    this.write(new Float32Array(Math.round(seconds * this.sampleRate)));
  }

  finish() {
    const out = this.encoder.flush();
    if (out.length) this.parts.push(new Uint8Array(out));
    return new Blob(this.parts, { type: 'audio/mpeg' });
  }
}

async function speak({ id, text, speed = 1 }) {
  const writer = new Mp3Writer(config.audio.sample_rate);
  writer.silence(0.3);
  for (const piece of splitText(text)) {
    try {
      writer.write(await synthesize(piece.text, speed));
    } catch (err) {
      // One unreadable piece (odd symbols, a table…) shouldn't stop the whole book.
      console.warn('Skipped a piece of text that could not be spoken:', piece.text.slice(0, 80), err);
    }
    writer.silence(piece.pause / speed);
    postMessage({ type: 'progress', id, chars: piece.text.length });
  }
  writer.silence(1);
  const mp3 = writer.finish();
  postMessage({ type: 'done', id, mp3, duration: writer.samples / writer.sampleRate });
}

// Messages are handled one at a time, in order.
let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(async () => {
    try {
      if (data.type === 'load') {
        await loadVoice(data.model, data.config);
        postMessage({ type: 'ready' });
      } else if (data.type === 'speak') {
        await speak(data);
      }
    } catch (err) {
      postMessage({ type: 'error', id: data.id, message: err?.message || String(err) });
    }
  });
};
