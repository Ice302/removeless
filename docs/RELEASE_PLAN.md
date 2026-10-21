# Removeless — Release Readiness & Improvement Plan (250 points)

Status at time of writing: **internal alpha (v0.13.0)**. The desktop app builds for macOS (arm64 + x64) and Windows (x64), the web/PWA build runs in Chromium, and an automated end-to-end self-test passes on macOS: import → voice isolation → five preview modes → ProRes 4444 / H.264 / WAV export. Points are ordered by release stage. **A** and **B** block a public launch. The rest are improvements, ending with experimental ideas.

---

## A. Release blockers found while building (1–20)

1. **Sign and notarize macOS builds.** Current DMGs are ad-hoc signed. Downloaded copies will be blocked by Gatekeeper. Get a Developer ID certificate, enable hardened runtime with `build/entitlements.mac.plist`, and notarize in CI (`.github/workflows/release.yml` is already wired to the secrets).
2. **Authenticode-sign Windows builds** (OV/EV certificate or Azure Trusted Signing). The unsigned NSIS installer triggers SmartScreen's "Windows protected your PC".
3. **Run the Windows build on real Windows.** It was cross-built on macOS and has never executed. Run `REMOVELESS_SELFTEST` on Windows 10/11 x64: the frameless window, DirectML DLL loading, `ffmpeg.exe` spawning and backslash paths are all untested.
4. **Intel Macs get no native inference.** onnxruntime-node 1.30 ships no `darwin/x64` binary, so the app falls back to WASM, about 2.7× slower (verified). Ship an older ORT x64 build, build ORT from source, or declare Apple Silicon the minimum.
5. **Keep the GPU accuracy verifier forever.** On this Apple GPU, ORT's WebGPU EP returned wrong RVM mattes: NHWC wrong everywhere, NCHW wrong on real frames for most sizes. The app detects this and falls back. File an upstream issue with the repro numbers and re-test on every ORT upgrade.
6. **Resolve the RVM GPL-3.0 licence** before shipping a closed-source build (see B21).
7. **Bounded memory for long audio.** Audio is decoded whole into float32: a 2-hour stereo podcast is about 2.7 GB and will crash. Process in overlapping chunks.
8. **4K export memory.** Each 4K RGBA frame crosses IPC at 33 MB. Test 4K and 8K on 8 GB machines and switch to shared-memory frame transport if needed.
9. **HDR sources.** HLG, PQ and Dolby Vision iPhone clips are processed as 8-bit BT.709 with no tone mapping, so they will look washed out. Detect and tone-map, or process 10-bit.
10. **Variable-frame-rate phone video.** Export forces constant frame rate via ffmpeg's `fps`, while the preview uses `currentTime`. Verify A/V sync on real iPhone/Android VFR footage over 10+ minutes.
11. **Rotated video.** The probe swaps dimensions for ±90° rotation metadata. Verify portrait phone clips end to end (preview, strokes, export orientation).
12. **Proxy cache grows forever** in the temp directory. Add LRU eviction and a "Clear cache" control.
13. **Native-host crash mid-export.** Add automatic restart and resume from the last written frame.
14. **Free-space check before export.** ProRes 4444 at 1080p is roughly 1.3 GB per minute.
15. **Cancelled PNG-sequence exports** leave partial folders behind. Clean them up or label them.
16. **Crash reporting** (Crashpad/Sentry, opt-in). Without it you are blind after launch.
17. **Auto-update** via electron-updater. Blockmaps are already generated; add `publish` config and staged rollout.
18. **Model integrity check** (SHA-256 of each `.onnx` at startup) to catch corrupted installs with a clear message.
19. **Verify file associations and "Open With"** on both OSes (registered in the builder config, not yet tested on Windows).
20. **Accessibility pass before 1.0** (section G). The EU Accessibility Act applies to many consumer software sales from June 2025.

## B. Legal, licensing & trust (21–35)

21. **RVM weights are GPL-3.0.** Shipping them in a closed app is a licensing risk. Options: release the app under GPL-3.0, license from the authors, make MODNet (Apache-2.0) the default, or train or distill a permissively licensed temporal matting model.
22. **MODNet is Apache-2.0.** It's safe, so make it the default engine if the app stays closed-source.
23. **The ffmpeg static builds are GPL** (libx264). Either GPL the app, or ship an LGPL ffmpeg and encode H.264/HEVC with OS encoders (VideoToolbox / Media Foundation).
24. **Codec patents** (H.264/HEVC/AAC pools). Using OS-provided encoders shifts licensing to the OS vendor; get advice before selling.
25. **ProRes.** `prores_ks` is reverse-engineered. Offer Apple's official VideoToolbox ProRes encoder on Mac for certified workflows.
26. **Trademarks.** Never market the app as "After Effects Roto Brush" or "ElevenLabs". The UI already uses neutral names (Roto Neural, Voice Isolate). Use comparative claims only with published benchmarks.
27. **Test fixtures.** The Pexels portrait is downloaded only by `tests/make-fixtures.sh`. Never bundle it.
28. **Ship licence texts** for Inter and IBM Plex Mono (OFL) inside the app, not just credits.
29. **Generate a third-party notices file** (`license-checker` / SBOM) and include it in app resources.
30. **Privacy policy.** "Everything runs on your device, nothing is uploaded" is true today and a strong selling point. Have it reviewed and keep it true.
31. **EULA** in the NSIS installer and the DMG licence window.
32. **Mac App Store export compliance:** set `ITSAppUsesNonExemptEncryption = false` (no custom crypto).
33. **Document Windows camera/mic privacy settings.** The macOS usage strings already exist.
34. **GDPR/CCPA:** any telemetry must be opt-in and media-free.
35. **Content credentials.** Consider signing exports with C2PA manifests ("background replaced, audio denoised") to get ahead of deepfake concerns.

## C. Matte accuracy — closing the gap to Roto Brush 2 + Refine Edge (36–61)

36. **Build a ground-truth benchmark** (VideoMatte240K, P3M-10k, AIM-500). Track SAD, MSE, gradient, connectivity and temporal dtSSD per release, and gate regressions in CI.
37. **Add BiRefNet-lite/HR (MIT)** as a "Max quality" engine for hero shots and stills.
38. **Ensemble RVM and MODNet** in the uncertain band (0.1 < α < 0.9), weighted by temporal agreement.
39. **Flow-based stroke propagation.** Replace centroid tracking with optical flow (RAFT-small or NeuFlow ONNX) warping of strokes and the previous matte. This is Roto Brush's core idea.
40. **"Freeze" ranges** like Roto Brush 2: cache propagated mattes for a span so later edits don't ripple.
41. **SAM 2 (Apache-2.0)** click-to-select with video propagation, for non-human subjects (products, pets, cars). RVM and MODNet are person-only.
42. **Trimap mode.** Paint an unknown band and run ViTMatte (MIT) for hair-level alpha.
43. **Dynamic-ROI refinement.** Re-run the matte at full resolution on a crop around the head and hair instead of the downsampled whole frame.
44. **"Refine Edge brush"** (as in AE). Apply detail recovery only where painted, with a per-region adaptive guided-filter radius.
45. **Motion-blurred alpha** synthesized from flow vectors (AE Refine Edge offers this).
46. **Better foreground estimation.** Replace normalized-convolution decontamination with multi-level foreground estimation (Germer et al.) or closed-form matting. This is a big win for hair over saturated backgrounds.
47. **Flow-warped temporal smoothing.** Currently motion-adaptive EMA; warping removes ghosting even during fast motion.
48. **Scene-cut detection** to reset recurrent state automatically (today it resets only on seeks and jumps).
49. **Shot auto-tune.** Analyse the first frames: green screen → Chroma Key, person → Roto Neural, otherwise → SAM.
50. **Keylight-grade chroma controls:** screen gain and balance, clip black/white, spill replacement colour, edge colour correction.
51. **Spatially varying key.** Sample many screen patches to handle uneven lighting (clean-plate estimation).
52. **Difference-matte engine** for locked-off shots (capture an empty plate once).
53. **Bezier masks with planar tracking** for hard-surface objects and garbage mattes.
54. **Engine A/B in split view:** a different engine on each side of the wipe.
55. **Uncertainty heatmap view** showing pixels where 0.05 < α < 0.95, telling the user where strokes will help.
56. **Editable stroke list.** Strokes already appear as blue timeline ticks; make them clickable, selectable and deletable individually.
57. **Per-stroke brush hardness** and a "snap to edges" toggle.
58. **Learn preferred settings per content type** from the user's own corrections (local only).
59. **Straight vs premultiplied alpha** export option (NLEs disagree; currently straight).
60. **High-bit-depth pipeline.** Processing is 8-bit RGBA today. Move to float16/float32 internally and offer ProRes 4444 XQ to avoid banding.
61. **Colour management.** Tag and convert BT.709 / BT.2020 / Display P3 correctly; currently BT.709 is assumed.

## D. Voice isolation — closing the gap to ElevenLabs Voice Isolator (62–85)

62. **Benchmark on DNS Challenge / VoiceBank-DEMAND** with DNSMOS, PESQ, STOI and SI-SDR, against ElevenLabs, Adobe Enhance and Krisp. Publish honest numbers. Current fixture result: ground-truth SNR 12.8 → 52.5 dB.
63. **Upgrade the neural stage to DeepFilterNet3** (MIT/Apache, full-band 48 kHz), which beats RNNoise on non-stationary noise. Keep RNNoise as "Light".
64. **Music removal.** Add a vocal-separation model (MDX/Demucs-class) as a "Remove music" toggle; ElevenLabs handles music beds.
65. **Dereverberation** (WPE as a classic first stage). Room echo is the most common complaint after noise.
66. **Optional generative "Studio" restoration:** bandwidth extension for phone and Zoom audio.
67. **De-click, de-pop and plosive removal** (mouth noise).
68. **Breath reduction**, driven by the VAD.
69. **Wind-noise detection and removal** for vlogs.
70. **Declipping** for blown-out recordings.
71. **"Learn noise from selection."** Mark a noise-only region on the timeline; today the profile comes only from the VAD.
72. **Per-speaker levelling** via diarization (podcasts).
73. **Mid/side processing** to keep the stereo image stable; channels are currently denoised independently.
74. **Spectrogram editor** with a spectral-repair brush, building on the Audio view.
75. **Real-time mode** (AudioWorklet + RNNoise) with a virtual microphone for calls and streams.
76. **True-peak (4× oversampled) metering, LRA, and platform loudness presets** (Spotify −14, Apple Podcasts −16, EBU R128 −23, ATSC −24).
77. **Automatic music ducking** under speech.
78. **Room-tone fill.** Gate down to consistent room tone instead of digital silence, to avoid an audible "pumping" effect.
79. **Verify sample-accurate sync on 1-hour files.** RNNoise latency (960 samples) is compensated and verified on a 17 s clip.
80. **Chunked processing** so progress and cancel are responsive and memory stays bounded.
81. **Cache processed audio per clip and settings.** Switching clips currently re-runs the chain.
82. **Blind A/B listening test mode** (randomized raw/processed) for honest self-evaluation.
83. **Optionally keep the original audio** as a second track in exports.
84. **Stem exports** (voice, residual noise) and **local captions** (Whisper) in the same export.
85. **Adaptive tonal-noise tracking** (fans, coil whine) beyond 50/60 Hz mains hum.

## E. Performance & hardware (86–103)

86. **Native GPU execution providers:** CoreML on Mac (55 ms vs 42 ms CPU on the A18 Pro test machine; M-series may differ), DirectML on Windows (DLLs already bundled), CUDA on Linux. Gate each with the existing accuracy verifier.
87. **Port the refine stack to WebGPU compute shaders.** It currently costs 40–80 ms in JavaScript at 540p and should be under 5 ms on the GPU.
88. **Zero-copy frame transport:** a SharedArrayBuffer ring between the ffmpeg reader and the worker, instead of structured-clone copies.
89. **Export pipeline parallelism:** decode, infer, refine and encode concurrently with several frames in flight.
90. **Hardware encoders:** VideoToolbox (H.264/HEVC/ProRes) on Mac; NVENC, QSV or AMF on Windows.
91. **Quantized int8 RVM** for draft preview; fp16 where verified accurate.
92. **Dynamic preview resolution** that holds about 24 fps by adapting quality.
93. **Background render cache.** Matte frames after import so scrubbing is instant, with a cache bar on the timeline (as in AE).
94. **Background batch queue** that keeps exporting while the user works; power- and thermal-aware on laptops.
95. **Shrink the 237 MB DMG.** Drop the 27 MB ORT WASM and the 13 MB fp16 MODNet on desktop when native works, and compress models.
96. **Download models on demand** per engine instead of bundling all four.
97. **Measure and cut cold-start time.** Defer the audio worker (a 4.8 MB wasm) until the first clip with audio.
98. **Memory hygiene:** cap the scratch pool, release buffers on clip switch, test 4K on 8 GB machines.
99. **Tune WASM thread count** for P/E-core layouts (currently 4 threads).
100. **Toggleable performance HUD** with per-stage milliseconds.
101. **Hidden benchmark command** (standard clip → fps report) for support and marketing.
102. **Segment-based, resumable, multi-process export** for many-core workstations.
103. **`powerSaveBlocker` during export** so laptops don't sleep mid-render.

## F. UX / UI — production-standard polish (104–131)

104. **First-run onboarding** (3 coach marks: Import → Paint → Export) with a bundled, self-produced demo clip.
105. **Paste to import** (⌘V files or URLs) on the empty state.
106. **Progressive disclosure:** five primary sliders per panel; tuck the rest under "Advanced".
107. **Slider affordances:** a default tick mark, type-to-edit values, scrubby labels, Shift for fine steps. Double-click currently resets; keep that, and add typing.
108. **Undo history panel**, standard in pro apps (⌘Z/⇧⌘Z already work).
109. **Settings snapshots A/B/C** with instant compare.
110. **Timeline:** zoom and pan, filmstrip thumbnails, J/K/L shuttle, markers, snapping for in/out points.
111. **Viewer:** zoom (fit / 100% / 200%), space-drag pan, a pixel inspector showing α under the cursor, checker size options.
112. **Pen pressure** (PointerEvent.pressure) for Wacom and Apple Pencil; show the brush size live while pressing `[` and `]`.
113. **Context menus:** viewer (clear strokes here, sample key), bin (reveal, remove, copy settings).
114. **Drag to reorder the bin; drag exported files straight into Finder or an NLE** (`webContents.startDrag`).
115. **Determinate progress, ETA and cancel for every long task.** Export has them; add them to proxy building and audio processing.
116. **OS notifications** when a background export finishes.
117. **Preferences window:** export folder, naming template, cache size, GPU toggle, threads, theme, language, telemetry.
118. **Command palette (⌘K)**, echoing the reference design, plus a customizable keymap.
119. **Explain the orbital dial.** "Isolation Strength" is a macro: highlight the linked sliders while dragging, and add a tooltip explaining the ° readout.
120. **Label the five view icons** on first use, not just in tooltips.
121. **Persist window state** (size, position, panel, tool, view).
122. **Collapsible side columns** for 13″ laptops. The layout fits 800 px tall today; test 1280×720 windows.
123. **Contrast audit.** Some 9–10 px grey mono labels fall below 4.5:1, especially in dark mode.
124. **Minimum UI text of 11 px**, plus a UI-scale setting.
125. **Keep motion subtle** and respect reduced-motion (already done).
126. **Actionable errors** ("This MOV is ProRes RAW, which isn't supported — export ProRes 422 instead") with "Copy diagnostics".
127. **Undo toasts for every destructive action.** Reset already has one; add Clear strokes and Remove clip.
128. **Consistent terminology** (matte vs mask vs alpha; keep vs cut) across UI, docs and tooltips.
129. **Extract a documented design system** (tokens, buttons, chips, sliders) with Storybook visual-regression snapshots in both themes.
130. **Usability testing every milestone** with 5–8 users per persona (YouTuber, podcaster, editor, VFX artist). Target time-to-first-export under 2 minutes.
131. **Measure the funnel** (import → first preview → first export) with opt-in, media-free events.

## G. Accessibility & internationalization (132–143)

132. **Screen readers:** VoiceOver/NVDA pass; sliders already expose labels and valuetext. Add live-region announcements for export progress and audio stats.
133. **Keyboard-only workflows** that don't require painting (presets, engines, export all reachable).
134. **axe-core checks in CI** and a focus-order audit.
135. **Never rely on colour alone** (FG/BG uses yellow vs blue; add +/− glyphs everywhere).
136. **Windows high-contrast / forced-colours** support.
137. **Captions** on all tutorial videos.
138. **Localize:** Spanish, Portuguese, Japanese, Korean, German, French, Hindi, Indonesian.
139. **RTL layout** for Arabic and Hebrew.
140. **Locale-aware numbers and dates** (the top-bar date is already locale-aware).
141. **UI zoom (⌘+ / ⌘−)**, persisted.
142. **Accessible error states** (icon and text, not colour only).
143. **Publish a VPAT** for education and enterprise buyers.

## H. Pro workflow features (144–161)

144. **NLE plug-ins** (Premiere/AE UXP, Resolve OFX, Final Cut FxPlug) calling the same engine. This is the biggest distribution channel.
145. **Watch-folder automation** (drop files → export with a preset).
146. **CLI** (`removeless in.mp4 --preset podcast --format prores`). The engine modules are already DOM-free.
147. **Export presets with naming templates** (`{name}_{preset}_{date}`).
148. **Multi-format single pass** (ProRes + MP4 + WAV from one decode).
149. **Video backgrounds** (loop/trim), plus light wrap and colour matching for realistic composites.
150. **Simple relighting:** match subject colour and temperature to the new background.
151. **Contact-shadow preservation** (separate shadow matte).
152. **Auto-reframe to 9:16 and 1:1**, using the subject centroid the matte already computes.
153. **Captions:** burn-in and SRT export via local Whisper.
154. **Thumbnail maker:** export a cut-out PNG of the best frame for YouTube thumbnails.
155. **Autosave, crash recovery and relinking** of missing media in projects.
156. **FCPXML/EDL import** to batch-process a timeline's clips.
157. **Apply settings to all multicam angles** in one go.
158. **Shareable presets** (file / link / QR) and a community preset gallery.
159. **Live mode:** a virtual camera with live background and noise removal for OBS, Zoom and Teams.
160. **Still-image mode** (single-frame path already exists in the pipeline).
161. **Audio-only podcast layout** that hides the video panels.

## I. Mobile (162–174)

162. **Real-device PWA testing:** iOS Safari 26 (WebGPU, WebCodecs, MediaRecorder MP4) and mid-range Android Chrome. Today it's verified in desktop Chromium only.
163. **Capacitor wrapper** for the App Store and Play Store, with native ONNX Runtime Mobile (CoreML/NNAPI) for speed.
164. **Mobile-first layout:** inspector as a bottom sheet, thumb-reachable transport, larger brush handles.
165. **Gestures:** pinch-zoom the viewer, two-finger tap to undo, long-press for the cut brush.
166. **Respect iOS memory limits:** default to Draft quality and 720p exports on phones.
167. **Background exports** via native background tasks; browsers suspend backgrounded tabs.
168. **Share-sheet export** to Photos, TikTok and Instagram.
169. **Front/back camera switch** in the camera recorder (live matte preview already works).
170. **Ask before downloading models** (~35–60 MB) on cellular; the service worker then caches them offline.
171. **Haptics** on brush commit, export done and errors.
172. **Mobile model variants** (int8 RVM ≈ 4 MB).
173. **Web Share Target** so people can "Share to Removeless" from the Photos app.
174. **Battery-aware preview** that pauses live inference in low-power mode.

## J. Packaging & distribution (175–187)

175. **Decide universal vs separate macOS binaries.** Separate arm64/x64 DMGs are built today.
176. **Mac App Store build** (sandbox, security-scoped bookmarks, ffmpeg as a sandboxed helper).
177. **Microsoft Store (MSIX) and winget**, which earn more trust than an unsigned NSIS installer.
178. **Homebrew cask, AppImage (CI already builds it), Flatpak.**
179. **Windows ARM64** (onnxruntime-node has win32/arm64; needs an arm64 ffmpeg).
180. **Linux arm64**, low priority.
181. **Branded DMG background** with drag-to-Applications layout.
182. **Branded NSIS installer.** Per-user install without admin rights is already configured.
183. **Delta updates** using the generated blockmaps.
184. **Alpha / beta / stable update channels.**
185. **Download page with OS/arch detection.**
186. **Publish SHA-256 checksums** for every artifact.
187. **Reproducible builds and an SBOM** (CycloneDX) from the lockfile.

## K. QA & reliability (188–203)

188. **Run the self-test in CI** on macOS and Windows runners (GPU-less runners still cover the native CPU path).
189. **Golden-frame tests:** compare exported frames to stored references by PSNR (native vs WASM already measured at 101.8 dB).
190. **Audio quality gates in CI** (e.g. GT-SNR ≥ 50 dB on the fixture via `tests/audio-quality.mjs`).
191. **Media compatibility matrix:** iPhone HEVC/HDR, Android VFR, GoPro, 10-bit 4:2:2 DSLR, ProRes 422/4444, DNxHR, AV1, VP9, MKV, AVI, MXF, 8K, 120 fps, mono/5.1, 44.1/96 kHz.
192. **Edge-case media:** corrupt, zero-length, audio-only, odd sizes (1919×1079), 180°/270° rotation, anamorphic.
193. **2-hour soak export** with heap snapshots to catch leaks.
194. **Replace text-parsing of `ffmpeg -i`** with ffprobe JSON, or fuzz the parser across ffmpeg versions.
195. **GPU verifier matrix:** Apple M1–M4, Intel Iris Xe, AMD, NVIDIA. Record which EPs and layouts pass.
196. **Playwright UI tests** (Electron mode) for core flows, with screenshots in both themes.
197. **Automated and manual accessibility tests** every release.
198. **Performance budgets** (preview ms/frame, export fps) enforced on a reference runner.
199. **Security tests** for the `app://` protocol: path traversal, unopened files must return 403 (both enforced today; lock them in with tests).
200. **Pseudo-locale testing** for truncation and RTL.
201. **Beta feedback button** that attaches logs and the self-test report (opt-in).
202. **Dogfood:** make every launch video with the app itself.
203. **Low-end hardware testing** (8 GB RAM, 4 cores) to set honest minimum specs.

## L. Privacy, analytics & support (204–213)

204. **Opt-in telemetry:** counts only (exports, engine, backend, fps), never media or file names.
205. **"Report a problem"** that bundles logs, system info and the GPU-verifier results.
206. **Diagnostics page** showing backend, GPU check numbers, versions and the ffmpeg path.
207. **Docs site:** quickstart, which engine when, troubleshooting (Gatekeeper, SmartScreen, codecs, `--safe-mode`).
208. **Persona-specific video tutorials.**
209. **Community** (Discord/forum), a public roadmap and feature voting.
210. **Support SLAs** for a paid tier.
211. **In-app "What's new"** after updates.
212. **Offline-friendly licence activation** if the app is paid.
213. **Remote feature flags** for staged rollouts.

## M. Staging & launch (214–228)

214. **Define personas and jobs-to-be-done.** North-star metric: share of first sessions that reach an export.
215. **Stages:** Internal alpha (now) → Closed beta (signed, crash reporting, ~50 users) → Public beta → Release candidate (feature freeze, bug bash) → 1.0.
216. **Exit criteria per stage:** crash-free sessions ≥ 99.5%, export success ≥ 98%, zero open P0/P1.
217. **Severity definitions and triage cadence** (P0 = data loss or crash, P1 = wrong output, …).
218. **Automated release checklist:** version bump → changelog → tag → CI builds → notarize → smoke test → publish.
219. **Semantic versioning.** The footer's "013" index is derived from the minor version; keep it in sync.
220. **Rollback plan:** keep previous installers; the updater can move users between channels.
221. **Branching:** protected `main`, release branches, code freeze before RC.
222. **Electron hardening review:** context isolation, sandbox and CSP are on. Add Electron Fuses (disable RunAsNode, enable asar integrity validation, OnlyLoadAppFromAsar).
223. **Performance sign-off** against the budgets in K198.
224. **Marketing site** with honest before/after demos and the benchmark table from C36/D62.
225. **Launch** on Product Hunt and Hacker News (the on-device privacy angle), plus creator partners on YouTube.
226. **Pricing experiments:** generous free tier (e.g. 1080p, no watermark, monthly minute cap) and a Pro tier.
227. **Post-launch:** weekly releases for a month, metric reviews, a hotfix lane.
228. **Version control.** The project folder isn't a git repository yet. Initialize it, protect `main`, require reviews.

## N. Business (229–232)

229. **Positioning:** "Roto and voice isolation, fully on-device, buy once", against subscription cloud tools.
230. **Education and enterprise licences** for privacy-sensitive organizations (legal, healthcare, government).
231. **License the DOM-free engine as an SDK** to other apps.
232. **Creator affiliate partnerships.**

## O. Novel & experimental ideas (233–250)

233. **Audio-visual speaker isolation.** Combine the matte, face landmarks and lip motion with the VAD to keep only the *on-screen* speaker's voice and suppress off-camera talkers.
234. **Speaker-aware matting.** In multi-person shots, use the voice activity to decide whom to keep.
235. **Depth-aware backgrounds.** Monocular depth (Depth Anything V2 small, Apache-2.0) enables parallax backdrops and "cinematic mode" blur for any video.
236. **Generative clean plates.** Inpaint the removed subject to produce an empty background, which also gives object removal.
237. **Matte-driven spatial audio.** Pan the voice to follow the subject's on-screen position (VR/AR and immersive exports).
238. **On-device adaptation.** Turn the user's strokes into training signal for a small per-project adapter, so the model improves as they correct it, privately.
239. **Confidence-guided editing.** Detect temporal-consistency spikes (dtSSD) and jump the user straight to the frames that need strokes.
240. **Scene-aware presets** ("street", "studio", "car") chosen automatically from audio and visual classification.
241. **NDI / virtual-camera output with alpha** for streamers: a green room without a green screen.
242. **C2PA provenance** written into every export (see B35) as a trust feature.
243. **Optional review links:** a proxy plus timecoded comments, for client approvals.
244. **Quality badges** on every export ("voice clarity 92", "edge stability 88") so users can judge results at a glance.
245. **WebXR preview:** place the cut-out subject in your room on a phone.
246. **Cinemagraphs:** freeze the background, keep the subject moving, using the matte.
247. **More editorial looks.** The reference's poster contour (stepped blue outline) ships as "Poster contour look"; add halftone, duotone and risograph looks for social.
248. **Audio-reactive matte effects** (glow or outline pulsing with voice energy) for music videos and shorts.
249. **Plug-in SDK** so the community can add looks, engines and export targets.
250. **"Fix it for me" helper.** Describe the problem in plain words ("hair looks blocky", "voice sounds underwater") and get recommended slider changes, optionally via a small local LLM.
