// Scripted end-to-end run used by CI / release checks (desktop only). Exercises import,
// audio isolation, every preview view, and real exports through ffmpeg.
export async function runSelfTest(api) {
  const { native, cfg, importPaths, S, setView, waitFor, exporter, store } = api;
  const report = { ok: false, steps: [], started: new Date().toISOString() };
  const step = async (name, fn) => {
    const t0 = performance.now();
    try {
      const detail = await fn();
      report.steps.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail });
    } catch (e) {
      report.steps.push({ name, ok: false, ms: Math.round(performance.now() - t0), error: e.message });
      throw e;
    }
  };
  const sep = cfg.outDir.includes('\\') ? '\\' : '/';
  try {
    if (cfg.engine) store.set({ engine: cfg.engine });
    if (cfg.theme) document.documentElement.dataset.theme = cfg.theme;
    await step('import', async () => { await importPaths([cfg.media]); return S.clip.info; });
    await step('audio isolate', async () => { await waitFor(() => S.audio.stats); return S.audio.stats; });
    for (const view of ['composite', 'alpha', 'overlay', 'split', 'audio']) {
      await step(`preview ${view}`, async () => {
        setView(view);
        S.lastStats = null;
        if (view !== 'audio') await waitFor(() => S.lastStats);
        await new Promise((r) => setTimeout(r, 400));
        await native.selftestCapture(`view-${view}.png`);
        return S.lastStats;
      });
    }
    setView('composite');
    if (cfg.previewOnly) { report.ok = true; throw new Error('preview-only run'); }
    store.set({ backdrop: 'color', backdropColor: '#E3F732' });
    await step('export prores4444 (transparent)', async () => {
      store.set({ backdrop: 'transparent' });
      return exporter.exportVideo(S.clip, 'prores4444', 0.5, `${cfg.outDir}${sep}out_prores4444.mov`);
    });
    await step('export mp4 (acid backdrop)', async () => {
      store.set({ backdrop: 'color', backdropColor: '#E3F732' });
      return exporter.exportVideo(S.clip, 'mp4_h264', 0.5, `${cfg.outDir}${sep}out_h264.mp4`);
    });
    await step('export wav', async () => exporter.exportAudio(S.clip, 'wav', `${cfg.outDir}${sep}out_voice.wav`));
    report.ok = true;
  } catch (e) {
    if (e.message !== 'preview-only run') report.error = e.message;
  }
  await native.selftestCapture('final.png').catch(() => {});
  await native.selftestDone(report);
}
