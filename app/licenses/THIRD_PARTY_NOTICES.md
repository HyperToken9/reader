# Third-party notices

Blitz ships, or downloads on first use, the following third-party software.
The full licence texts are in this directory.

## eSpeak NG 1.52.0 — GPL-3.0-or-later

Blitz's speech engine turns text into phonemes with libespeak-ng, which is
shipped with the app as `vendor/espeak-ng/libespeak-ng.so` together with its
English data files (`vendor/espeak-ng/espeak-ng-data/`), unmodified.

- Copyright (C) 2005–2014 Jonathan Duddington; 2015–2024 Reece H. Dunn and the eSpeak NG contributors.
- Licence: GNU General Public License, version 3 or later — `espeak-ng-GPL-3.0.txt`.
- Source: <https://github.com/espeak-ng/espeak-ng/tree/1.52.0>
- The binary and data were taken from the espeakng-loader 0.2.4 wheel
  (<https://pypi.org/project/espeakng-loader/0.2.4/>, built from
  <https://github.com/thewh1teagle/espeakng-loader>), and only the English
  data files were kept.

eSpeak NG is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
A PARTICULAR PURPOSE. See the GNU General Public License for more details.

## Kokoro-82M weights — Apache-2.0 (downloaded, not shipped)

The voice model is downloaded the first time speech is used, from
kokoro-onnx's releases (<https://github.com/thewh1teagle/kokoro-onnx/releases>).
Kokoro-82M is by hexgrad (<https://huggingface.co/hexgrad/Kokoro-82M>), under
the Apache License 2.0.

## koffi 3.3.3 — MIT

Foreign-function interface used to call libespeak-ng.
Copyright (C) Niels Martignène — `koffi-MIT.txt`.

## ONNX Runtime 1.23.2 and 1.29 — MIT

Runs the speech and layout models. Copyright (c) Microsoft Corporation.
<https://github.com/microsoft/onnxruntime/blob/main/LICENSE>
