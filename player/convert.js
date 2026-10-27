'use strict';

// "Make audiobook": turns a PDF, EPUB or TXT book into MP3 chapters inside the browser.
// The voices (Piper) run in Web Workers (tts-worker.js); finished chapters go straight into
// the library, so listening can start while the rest of the book is still being made.

const VOICES = [
  {
    id: 'lessac',
    name: 'Lessac (female, American English)',
    model: 'voices/en_US-lessac-medium.onnx',
    config: 'voices/en_US-lessac-medium.onnx.json',
  },
  {
    id: 'ryan',
    name: 'Ryan (male, American English)',
    model: 'voices/en_US-ryan-medium.onnx',
    config: 'voices/en_US-ryan-medium.onnx.json',
  },
];
const SAMPLE_TEXT =
  'Hello! This is how your audiobook will sound. It was a bright cold day in April, and the clocks were striking thirteen.';
const WORDS_PER_MINUTE = 155; // typical narration speed, for estimates

// One voice running in its own worker.
class Voice {
  constructor(voice) {
    this.voice = voice;
    this.requests = new Map();
    this.worker = new Worker('tts-worker.js');
    this.worker.onmessage = e => this.handle(e.data);
    this.worker.onerror = e => this.fail(new Error(e.message || 'The voice stopped working.'));
  }

  load(onDownload) {
    this.onDownload = onDownload;
    this.ready = new Promise((resolve, reject) => {
      this.loaded = { resolve, reject };
    });
    this.worker.postMessage({ type: 'load', model: this.voice.model, config: this.voice.config });
    return this.ready;
  }

  speak(text, speed, onProgress) {
    const id = newId();
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ type: 'speak', id, text, speed });
    });
  }

  handle(msg) {
    const request = this.requests.get(msg.id);
    if (msg.type === 'loading') this.onDownload?.(msg.loaded, msg.total);
    else if (msg.type === 'ready') this.loaded.resolve();
    else if (msg.type === 'progress') request?.onProgress?.(msg.chars);
    else if (msg.type === 'done') {
      this.requests.delete(msg.id);
      request?.resolve(msg);
    } else if (msg.type === 'error') {
      const err = new Error(msg.message);
      if (request) {
        this.requests.delete(msg.id);
        request.reject(err);
      } else this.loaded?.reject(err);
    }
  }

  fail(err) {
    this.loaded?.reject(err);
    for (const request of this.requests.values()) request.reject(err);
    this.requests.clear();
  }

  stop() {
    this.worker.terminate();
    this.fail(new Error('Stopped.'));
  }
}

const Converter = (() => {
  let chosen = null; // the book read from the chosen file
  let job = null; // the book being made right now
  let sample = null; // { voice, audio } for "Play a sample"
  let wakeLock = null;
  let shownBookId = null; // the book on the progress screen

  const panels = ['cv-pick', 'cv-reading', 'cv-setup', 'cv-progress'];
  function showPanel(id) {
    for (const panel of panels) $(panel).hidden = panel !== id;
  }

  // Several voices work on different chapters at once; each uses one processor core.
  function workerCount() {
    const cores = navigator.hardwareConcurrency || 2;
    const memory = navigator.deviceMemory || 4;
    if (memory <= 2) return 1;
    return Math.max(1, Math.min(4, Math.floor(cores / 2), Math.floor(memory / 2)));
  }

  function megabytes(bytes) {
    return Math.round(bytes / 1e6);
  }

  function downloadMessage(loaded, total) {
    return total
      ? `Downloading the voice (${megabytes(loaded)} of ${megabytes(total)} MB). This only happens once.`
      : `Downloading the voice (${megabytes(loaded)} MB). This only happens once.`;
  }

  // ---------- Choosing a book ----------

  async function chooseFile(file) {
    showPanel('cv-reading');
    try {
      chosen = await BookText.read(file);
    } catch (err) {
      console.error(err);
      showPanel('cv-pick');
      toast(err instanceof BookText.BookError ? err.message : 'Sorry, this book couldn’t be read.');
      return;
    }

    $('cv-title').value = chosen.title;
    $('cv-author').value = chosen.author;
    const words = chosen.chapters.reduce((sum, ch) => sum + BookText.wordCount(ch.text), 0);
    const minutes = words / WORDS_PER_MINUTE;
    $('cv-summary').textContent =
      `${chosen.chapters.length} chapter${chosen.chapters.length === 1 ? '' : 's'} · ` +
      `${words.toLocaleString()} words · about ${formatLong(minutes * 60)} of listening. ` +
      'Making the audio takes a while: on a computer often a quarter of the listening time, on a phone longer.';

    const list = $('cv-chapters');
    list.replaceChildren();
    for (const ch of chosen.chapters) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = ch.title;
      const count = document.createElement('span');
      count.className = 'muted';
      count.textContent = `${BookText.wordCount(ch.text).toLocaleString()} words`;
      li.append(name, count);
      list.append(li);
    }
    showPanel('cv-setup');
  }

  // ---------- Voice sample ----------

  function stopSample() {
    if (!sample) return;
    sample.audio?.pause();
    sample.voice.stop();
    sample = null;
    $('cv-preview').textContent = 'Play a sample';
    $('cv-voice-status').hidden = true;
  }

  async function playSample() {
    if (sample) {
      stopSample();
      return;
    }
    const voice = VOICES.find(v => v.id === $('cv-voice').value);
    const status = $('cv-voice-status');
    const mine = (sample = { voice: new Voice(voice) });
    $('cv-preview').textContent = 'Stop sample';
    status.hidden = false;
    status.textContent = 'Getting the voice ready…';
    try {
      await mine.voice.load((loaded, total) => {
        status.textContent = downloadMessage(loaded, total);
      });
      status.textContent = 'Making a sample…';
      const result = await mine.voice.speak(SAMPLE_TEXT, Number($('cv-speed').value));
      if (sample !== mine) return;
      status.hidden = true;
      mine.audio = new Audio(URL.createObjectURL(result.mp3));
      mine.audio.onended = stopSample;
      await mine.audio.play();
    } catch (err) {
      if (sample !== mine) return;
      stopSample();
      toast(`The voice couldn’t be loaded: ${err.message}`);
    }
  }

  // ---------- Making the audiobook ----------

  async function start() {
    stopSample();
    if (job) {
      toast('Another book is being made. Wait for it to finish, or stop it first.');
      return;
    }
    const id = newId();
    const book = {
      id,
      title: $('cv-title').value.trim() || chosen.title,
      author: $('cv-author').value.trim(),
      chapters: chosen.chapters.map(ch => ({ title: ch.title, fileId: null, duration: 0 })),
      position: { chapter: 0, time: 0 },
      rate: 1,
      finished: false,
      making: true,
      addedAt: Date.now(),
      lastPlayedAt: 0,
    };
    if (chosen.cover) {
      book.coverId = newId();
      await db.putFile({ id: book.coverId, blob: chosen.cover });
    }
    await db.putBook(book);
    await db.putJob({
      id,
      voice: $('cv-voice').value,
      speed: Number($('cv-speed').value),
      texts: chosen.chapters.map(ch => ch.text),
    });
    navigator.storage?.persist?.();
    chosen = null;
    await run(id);
  }

  async function run(bookId) {
    const book = await db.getBook(bookId);
    const saved = await db.getJob(bookId);
    if (!book || !saved) {
      toast('The text of this book is no longer saved. Please choose the book file again.');
      return;
    }
    const voice = VOICES.find(v => v.id === saved.voice) || VOICES[0];
    const queue = book.chapters.map((ch, i) => i).filter(i => !book.chapters[i].fileId);
    const totalChars = queue.reduce((sum, i) => sum + saved.texts[i].length, 0) || 1;

    job = { bookId, voices: [], stopped: false, doneChars: 0, startedAt: 0, failed: null };
    shownBookId = bookId;
    const thisJob = job;
    let ready = book.chapters.length - queue.length;

    showView('convert');
    showPanel('cv-progress');
    $('cp-title').textContent = book.title;
    $('cp-fill').style.width = `${(ready / book.chapters.length) * 100}%`;
    $('cp-status').textContent = 'Getting the voice ready…';
    $('cp-note').hidden = false;
    $('cp-listen').disabled = ready === 0;
    $('cp-download').hidden = true;
    $('cp-new').hidden = true;
    $('cp-stop').hidden = false;
    await keepAwake();
    renderLibrary();

    const progress = () => {
      if (thisJob.stopped) return;
      const fraction = Math.min(1, thisJob.doneChars / totalChars);
      const overall = (ready + fraction * queue.length) / book.chapters.length;
      $('cp-fill').style.width = `${Math.max(overall * 100, 1)}%`;
      let text = `${ready} of ${book.chapters.length} chapters ready · ${Math.floor(overall * 100)}%`;
      const elapsed = (Date.now() - thisJob.startedAt) / 1000;
      if (fraction > 0.02 && elapsed > 20) {
        const left = (elapsed / fraction) * (1 - fraction);
        text += left < 60 ? ' · less than a minute left' : ` · about ${formatLong(left)} left`;
      }
      $('cp-status').textContent = text;
    };

    // Each voice takes the next chapter in line until there are none left.
    const work = async v => {
      while (queue.length && !thisJob.stopped) {
        const index = queue.shift();
        const result = await v.speak(saved.texts[index], saved.speed, chars => {
          thisJob.doneChars += chars;
          progress();
        });
        if (thisJob.stopped) return;
        const fileId = newId();
        await db.putFile({ id: fileId, blob: result.mp3 });
        const updated = await db.updateBook(bookId, b => {
          b.chapters[index].fileId = fileId;
          b.chapters[index].duration = result.duration;
        });
        if (!updated) {
          stopJob(); // the book was removed
          return;
        }
        ready++;
        $('cp-listen').disabled = false;
        progress();
        chapterReady(bookId, index);
        if (!$('library').hidden) renderLibrary();
      }
    };

    try {
      const first = new Voice(voice);
      thisJob.voices.push(first);
      await first.load((loaded, total) => {
        $('cp-status').textContent = downloadMessage(loaded, total);
      });
      thisJob.startedAt = Date.now();
      progress();
      const workers = [work(first)];
      for (let n = 1; n < Math.min(workerCount(), queue.length + 1); n++) {
        const extra = new Voice(voice);
        thisJob.voices.push(extra);
        // A helper that can't start (for example, low memory) is simply left out.
        workers.push(extra.load().then(() => work(extra), () => extra.stop()));
      }
      await Promise.all(workers);
    } catch (err) {
      if (!thisJob.stopped) {
        console.error(err);
        thisJob.failed = err;
      }
    }

    for (const v of thisJob.voices) v.worker.terminate();
    releaseAwake();
    if (job === thisJob) job = null;

    if (thisJob.failed) {
      $('cp-status').textContent = `Something went wrong: ${thisJob.failed.message} The finished chapters are kept. You can continue from the Library.`;
      finishButtons(bookId, ready > 0);
    } else if (!thisJob.stopped) {
      await db.updateBook(bookId, b => {
        b.making = false;
      });
      await db.deleteJob(bookId);
      const total = (await db.getBook(bookId))?.chapters.reduce((sum, ch) => sum + (ch.duration || 0), 0) || 0;
      $('cp-fill').style.width = '100%';
      $('cp-status').textContent = `Finished! ${book.chapters.length} chapters, ${formatLong(total)} of listening. It’s in your Library.`;
      finishButtons(bookId, true);
      toast(`"${book.title}" is ready.`);
      if (current?.id === bookId) current.making = false;
    }
    renderLibrary();
    showUnfinished();
  }

  function finishButtons(bookId, canDownload) {
    $('cp-note').hidden = true;
    $('cp-stop').hidden = true;
    $('cp-new').hidden = false;
    $('cp-download').hidden = !canDownload;
    $('cp-download').onclick = () => downloadBook(bookId);
  }

  function stopJob() {
    if (!job) return;
    const stopped = job;
    stopped.stopped = true;
    for (const v of stopped.voices) v.stop();
    job = null;
    releaseAwake();
    $('cp-status').textContent = 'Stopped. The chapters made so far are in your Library, where you can continue making the rest later.';
    finishButtons(stopped.bookId, true);
    renderLibrary();
    showUnfinished();
  }

  // Ask the device not to sleep while making audio (phones pause pages that are in the background).
  async function keepAwake() {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      wakeLock = null;
    }
  }

  function releaseAwake() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }

  async function showUnfinished() {
    const box = $('cv-resume');
    const books = (await db.allBooks()).filter(b => b.making && b.id !== job?.bookId);
    box.replaceChildren();
    box.hidden = !books.length;
    if (!books.length) return;
    const heading = document.createElement('p');
    heading.textContent = 'Not finished yet:';
    box.append(heading);
    for (const book of books) {
      const ready = book.chapters.filter(ch => ch.fileId).length;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = `Continue "${book.title}" (${ready} of ${book.chapters.length} chapters done)`;
      btn.addEventListener('click', () => resume(book.id));
      box.append(btn);
    }
  }

  function resume(bookId) {
    if (job) {
      toast('Another book is being made. Wait for it to finish, or stop it first.');
      showView('convert');
      return;
    }
    run(bookId);
  }

  // ---------- Events ----------

  for (const v of VOICES) {
    const option = document.createElement('option');
    option.value = v.id;
    option.textContent = v.name;
    $('cv-voice').append(option);
  }

  $('pick-book').addEventListener('change', e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) chooseFile(file);
  });
  $('cv-setup').addEventListener('submit', e => {
    e.preventDefault();
    start();
  });
  $('cv-preview').addEventListener('click', playSample);
  $('cv-voice').addEventListener('change', stopSample);
  $('cv-other').addEventListener('click', () => {
    stopSample();
    chosen = null;
    showPanel('cv-pick');
  });
  $('cp-stop').addEventListener('click', stopJob);
  $('cp-new').addEventListener('click', () => showPanel('cv-pick'));
  $('cp-listen').addEventListener('click', () => {
    if (shownBookId) openBook(shownBookId);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && job && !wakeLock) keepAwake();
  });
  window.addEventListener('beforeunload', e => {
    if (job) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  return {
    isMaking: id => job?.bookId === id,
    resume,
    stop: id => {
      if (job?.bookId === id) stopJob();
    },
    showUnfinished,
  };
})();
