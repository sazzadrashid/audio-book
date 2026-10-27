# Third-party files

Copies of these libraries are kept here so the website works without loading anything from other sites.

| Folder | Library | Version | Licence |
| --- | --- | --- | --- |
| `ort/` | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) (`ort.wasm.min.js` and its WebAssembly files) | 1.18.0 | MIT |
| `piper/` | [piper-wasm](https://www.npmjs.com/package/@diffusionstudio/piper-wasm): [piper-phonemize](https://github.com/rhasspy/piper-phonemize) and [eSpeak NG](https://github.com/espeak-ng/espeak-ng) compiled to WebAssembly | 1.0.0 | MIT; eSpeak NG is GPL-3.0 (source at the link) |
| `lame/` | [lamejs](https://github.com/zhuker/lamejs) MP3 encoder | 1.2.1 | LGPL-3.0 |
| `pdfjs/` | [PDF.js](https://github.com/mozilla/pdf.js) | 4.10.38 | Apache-2.0 |
| `jszip/` | [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT or GPL-3.0 |

## Voices (`../voices/`)

[Piper](https://github.com/rhasspy/piper) voices, taken from the
[sherpa-onnx voice packages](https://github.com/k2-fsa/sherpa-onnx/releases/tag/tts-models):

| Voice | Trained on | Dataset licence |
| --- | --- | --- |
| `en_US-lessac-medium` | [Lessac / Blizzard 2013](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/) | [Blizzard 2013 licence](https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html) |
| `en_US-ryan-medium` | [RyanSpeech](https://www.kaggle.com/datasets/roholazandie/ryanspeech) | CC BY-NC-SA 4.0 (non-commercial) |
