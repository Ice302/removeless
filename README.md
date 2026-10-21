# Removeless

Removes video backgrounds and background noise, on device. A desktop app for macOS and Windows, plus an installable web app (PWA) for browsers and mobile. The UI follows the "END IS UI . 013" design language.

- **Video:** neural matting with temporal memory (RVM), portrait matting (MODNet), or a colour-difference chroma keyer. These are followed by a Refine Edge stack modelled on After Effects' Roto Brush 2: tracked +FG / −BG hint strokes, guided-filter edge snap, threshold and contrast, shift edge (choke/spread), feather, motion-adaptive chatter reduction, edge-colour decontamination and despill.
- **Audio:** a voice-isolation chain in the spirit of ElevenLabs' Voice Isolator: 4th-order high-pass → automatic 50/60 Hz hum notch comb → RNNoise neural denoiser (latency-compensated, sample-accurate) → adjustable reduction depth → STFT Wiener residual cleanup → VAD voice gate → presence EQ → de-esser → dry/wet → BS.1770 loudness normalization → look-ahead limiter.
- **Export (desktop, via bundled ffmpeg):** ProRes 4444 with alpha, WebM VP9 with alpha, HEVC with alpha (macOS), H.264 MP4 (composited), luma-matte MP4, PNG sequence + WAV, and audio as WAV/FLAC/AAC.
- **Export (web/mobile, via WebCodecs):** MP4, WebM with alpha, WAV.

## Install

| Platform | File (in `release/`) | Notes |
|---|---|---|
| macOS, Apple Silicon | `Removeless-0.13.0-arm64.dmg` | Fully tested. Native inference. |
| macOS, Intel | `Removeless-0.13.0.dmg` | Built, not run (no Intel Mac available). Uses WASM inference (onnxruntime-node has no Intel-Mac build). |
| Windows x64 | `Removeless-Setup-0.13.0.exe` (or the portable `-win.zip`) | Cross-built on macOS. **Not yet run on Windows.** |
| Browser / mobile | `npm run build:web`, then host `dist/` over HTTPS | Tested in desktop Chromium. Installable as a PWA. |

The builds are **not code-signed yet**:
- macOS: right-click the app → Open, or run `xattr -dr com.apple.quarantine /Applications/Removeless.app`.
- Windows: SmartScreen → More info → Run anyway.

## Develop

```bash
npm install                      # npm ≥ 11 blocks install scripts; then run:
npm install-scripts approve electron ffmpeg-static && npm rebuild electron ffmpeg-static
npm run fetch:ffmpeg             # static ffmpeg for this OS → vendor/ffmpeg/
npm run dev:desktop              # Vite + Electron with hot reload
npm run dev                      # web build only (http://localhost:5173)
```

Build installers with `npm run dist:mac` (arm64 + x64), `npm run dist:win` (x64; NSIS works from macOS) or `npm run dist:linux`. The GitHub Actions workflow in `.github/workflows/release.yml` builds all three plus the web bundle, and signs and notarizes when the secrets are set.

## Architecture

```
renderer (UI, src/main.js)
 ├─ matte worker (src/workers/matte.worker.js) ── MattePipeline (src/engine/matte-pipeline.js)
 │    ├─ desktop: MessagePort ──► native inference host (electron/infer.cjs, onnxruntime-node)
 │    └─ web / fallback: onnxruntime-web (WASM, threaded; WebGPU only if it passes verification)
 ├─ audio worker (src/workers/audio.worker.js) ── VoiceIsolator (src/engine/audio-dsp.js) + RNNoise
 ├─ player (src/audio-player.js): raw + isolated buffers locked to the <video> clock (instant A/B)
 └─ exporter (src/exporter.js)
      ├─ desktop: ffmpeg decode → matte worker → ffmpeg encode (electron/ffmpeg.js)
      └─ web: Mediabunny/WebCodecs decode → matte worker → encode
main process (electron/main.js): window, menus, secure app:// protocol (COOP/COEP,
                                 range requests, only user-opened files), dialogs
```

**GPU safety.** ONNX Runtime's WebGPU backend computed wrong mattes on the Apple GPU used for development. Before trusting the GPU, the app compares it with the CPU at each real resolution (on a noise test frame and on the clip's first frame), and falls back automatically if they disagree. `--safe-mode` (or `?gpu=0` on the web) forces CPU inference, and `REMOVELESS_NO_NATIVE=1` disables the native inference host.

## Verified results (development machine: Apple A18 Pro, macOS 26)

| Check | Result |
|---|---|
| Voice isolation, ground-truth SNR on the noisy fixture | 12.8 dB → **52.5 dB** (default chain); voice fidelity SI-SDR 12.3 → 11.5 dB (the drop is from the intentional presence EQ and de-esser) |
| Hum detection / loudness | 60 Hz found and notched; output exactly −16.0 LUFS |
| RNNoise alignment | 960-sample latency measured and compensated |
| Synthetic green screen, mean alpha error | keyer 0.0112 → 0.0039 refined (2.9× better) |
| Hint strokes | BG cut α 1.00 → 0.00; FG keep 0.00 → 1.00; follows a 96 px subject move |
| Native vs WASM export alpha | 101.8 dB PSNR (identical); native exports 2.8× faster |
| Packaged macOS app, end-to-end self-test | import, audio, 5 views, ProRes 4444 (yuva444p12le + 24-bit PCM), H.264 + AAC, WAV: all pass |
| Web build in Chromium | import, isolate, preview, MP4, WebM (yuva420p alpha), WAV: all pass |

Reproduce: `tests/make-fixtures.sh tests/fixtures`, then
- `node tests/audio-quality.mjs tests/fixtures/noisy.wav tests/fixtures/clean.wav`
- `node tests/matte-quality.mjs tests/fixtures/person.jpg /tmp/matte`
- `tests/selftest-run.sh "$PWD/tests/fixtures/test_street.mp4" /tmp/st`

## Licences — read before distributing

- RVM ("Roto Neural") weights are **GPL-3.0**; MODNet ("Portrait") is Apache-2.0.
- The bundled ffmpeg builds are **GPL**.
- RNNoise is BSD; ONNX Runtime MIT; Mediabunny MPL-2.0; fonts OFL.

Shipping a closed-source build requires replacing or licensing the GPL parts. See `docs/RELEASE_PLAN.md` §B.

## Shortcuts

`Space` play · `←/→` frame · `I/O` in/out · `\` hold for raw · `1–5` views · `R E V B D X` tools · `F/C` keep/cut brush · `[ ]` brush size · `⌘Z/⇧⌘Z` undo/redo · `⌘O` import · `⌘S` save project · `⌘E` export · `?` all shortcuts
