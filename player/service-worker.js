'use strict';

// Lets the app open without internet once it has been opened online.
// App files: fetched fresh when online (so updates arrive), the saved copy when offline.
// Voices and big libraries for making audiobooks: kept after first use, since they never change.
// Audiobook audio is never stored here: your books are already saved in the library (IndexedDB),
// and published books stream from the site.

const CACHE = 'audio-book-v3';
const APP_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'reader.js',
  'read-along.js',
  'book-text.js',
  'speech-text.js',
  'convert.js',
  'desktop.js',
  'tts-worker.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/jszip/jszip.min.js',
  'vendor/opendyslexic/opendyslexic-400.woff2',
  'vendor/inter/inter.woff2',
  'vendor/literata/literata.woff2',
];
const KEEP_AFTER_FIRST_USE = /\/(voices|vendor)\//;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  // Only this site's files; never partial requests (audio seeking) or published audiobooks.
  if (request.method !== 'GET' || url.origin !== location.origin || request.headers.has('range') || url.pathname.includes('/books/')) return;

  if (KEEP_AFTER_FIRST_USE.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(saved => saved || fetch(request).then(response => keep(request, response))),
    );
    return;
  }
  event.respondWith(
    fetch(request)
      .then(response => keep(request, response))
      .catch(() => caches.match(request, { ignoreSearch: true }).then(saved => saved || caches.match('index.html'))),
  );
});

function keep(request, response) {
  if (response.ok && response.status === 200) {
    const copy = response.clone();
    caches.open(CACHE).then(cache => cache.put(request, copy));
  }
  return response;
}
