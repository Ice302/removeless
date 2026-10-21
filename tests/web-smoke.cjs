// Smoke test of the web/PWA build in a plain Chromium window (no Electron bridge).
// Usage: npx vite preview --port 4173 &  then  npx electron tests/web-smoke.cjs <clipUrl> <outDir>
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const [clipUrl, outDir] = process.argv.slice(-2);

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const downloads = [];
  session.defaultSession.on('will-download', (_e, item) => {
    const file = path.join(outDir, item.getFilename());
    item.setSavePath(file);
    item.once('done', (_ev, state) => downloads.push({ file, state, bytes: item.getTotalBytes() }));
  });
  const win = new BrowserWindow({ width: 1400, height: 900, show: true });
  win.webContents.on('console-message', (e) => process.stderr.write(`[web:${e.level}] ${e.message}\n`));
  await win.loadURL('http://localhost:4173/?debug');
  const report = await win.webContents.executeJavaScript(`(async () => {
    const R = window.__removeless, out = { steps: [] };
    const waitFor = (fn, ms = 120000) => new Promise((res, rej) => { const t0 = Date.now(); (function poll() { const v = fn(); if (v) return res(v); if (Date.now() - t0 > ms) return rej(new Error('timeout')); setTimeout(poll, 100); })(); });
    try {
      out.isolated = self.crossOriginIsolated;
      const blob = await (await fetch(${JSON.stringify(clipUrl)})).blob();
      await R.importFiles([new File([blob], 'test_street.mp4', { type: 'video/mp4' })]);
      out.steps.push(['import', R.S.clip.info]);
      await waitFor(() => R.S.audio.stats);
      out.steps.push(['audio', { reduction: R.S.audio.stats.noiseReduction, lufs: R.S.audio.stats.lufs }]);
      R.setView('composite'); R.S.lastStats = null;
      await waitFor(() => R.S.lastStats);
      out.steps.push(['preview', R.S.lastStats]);
      R.store.set({ backdrop: 'color', backdropColor: '#E3F732' });
      const t0 = performance.now();
      const res = await R.exporter.exportVideo(R.S.clip, 'web_mp4', 0.5);
      out.steps.push(['export web_mp4', { ...res, ms: Math.round(performance.now() - t0) }]);
      R.store.set({ backdrop: 'transparent' });
      const res2 = await R.exporter.exportVideo(R.S.clip, 'web_webm', 0.5);
      out.steps.push(['export web_webm (alpha)', res2]);
      await R.exporter.exportAudio(R.S.clip, 'wav');
      out.ok = true;
    } catch (e) { out.error = e.message + ' ' + (e.stack || '').split('\\n').slice(0, 3).join(' | '); }
    return out;
  })()`);
  await new Promise((r) => setTimeout(r, 2500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'web.png'), img.toPNG());
  report.downloads = downloads;
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 1).slice(0, 3000));
  app.exit(report.ok ? 0 : 1);
});
