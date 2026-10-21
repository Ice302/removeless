// Electron main process: window, menu, secure app:// protocol, and IPC to ffmpeg.
import electron from 'electron';
import { createReadStream, statSync, existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as ff from './ffmpeg.js';

// Electron's ESM loader only exposes the default export reliably.
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, nativeTheme, utilityProcess, MessageChannelMain } = electron;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(app.getAppPath(), 'dist');

// Only files the user explicitly opened (dialog, drag-drop, OS "Open With") are servable.
const allowedMedia = new Set();
// End-to-end self-test: REMOVELESS_SELFTEST='{"media":"/abs/clip.mp4","outDir":"/abs/dir"}'
const SELFTEST = process.env.REMOVELESS_SELFTEST ? JSON.parse(process.env.REMOVELESS_SELFTEST) : null;
if (SELFTEST?.media) allowedMedia.add(SELFTEST.media);
let win = null;
let pendingOpen = [];

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true },
}]);

function resolveFfmpeg() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'ffmpeg', exe)]
    : [path.join(app.getAppPath(), 'vendor', 'ffmpeg', `${process.platform}-${process.arch}`, exe),
       path.join(app.getAppPath(), 'node_modules', 'ffmpeg-static', exe)];
  return candidates.find((p) => existsSync(p)) || 'ffmpeg';
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg',
};
// Cross-origin isolation enables SharedArrayBuffer → multi-threaded WASM inference.
const ISOLATION = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  // app://media is a different origin from the page; CORS keeps video frames readable
  // (untainted) for createImageBitmap/getImageData.
  'Access-Control-Allow-Origin': '*',
};

function serveFile(file, request) {
  const st = statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
    return new Response(Readable.toWeb(createReadStream(file, { start, end })), {
      status: 206,
      headers: { ...ISOLATION, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${st.size}` },
    });
  }
  return new Response(Readable.toWeb(createReadStream(file)), {
    headers: { ...ISOLATION, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(st.size) },
  });
}

function registerProtocol() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    try {
      if (url.host === 'media') {
        const file = decodeURIComponent(url.pathname.slice(1));
        if (!allowedMedia.has(file) || !existsSync(file)) return new Response('Forbidden', { status: 403 });
        return serveFile(file, request);
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel === '/' || rel === '') rel = '/index.html';
      const file = path.normalize(path.join(DIST, rel));
      if (!file.startsWith(DIST) || !existsSync(file)) return new Response('Not found', { status: 404 });
      return serveFile(file, request);
    } catch (e) {
      return new Response(String(e), { status: 500 });
    }
  });
}

const allow = (p) => { allowedMedia.add(p); return p; };

function createWindow() {
  win = new BrowserWindow({
    width: 1480, height: 940, minWidth: 1080, minHeight: 700,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1A1C20' : '#C3C7CC',
    title: 'Removeless',
    show: false,
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 } }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false, // exports keep running when the window is hidden
    },
  });
  win.once('ready-to-show', () => win.show());
  if (SELFTEST || !app.isPackaged) {
    win.webContents.on('console-message', (e) => {
      const { level, message, sourceId, lineNumber } = e;
      process.stderr.write(`[renderer:${level}] ${message} (${String(sourceId).split('/').pop()}:${lineNumber})\n`);
    });
  }
  win.on('maximize', () => win.webContents.send('window-state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('window-state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('did-finish-load', () => {
    if (pendingOpen.length) win.webContents.send('open-files', pendingOpen.splice(0));
  });
  const query = SELFTEST?.gpu === false || process.argv.includes('--safe-mode') ? '?gpu=0' : '';
  win.loadURL(`${DEV_URL || 'app://studio/index.html'}${query}`);
}

function sendMenu(action) { win?.webContents.send('menu', action); }

function buildMenu() {
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import Media…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('import') },
        { label: 'Open Project…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendMenu('open-project') },
        { label: 'Save Project…', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save-project') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export') },
        { label: 'Export Audio…', accelerator: 'CmdOrCtrl+Shift+E', click: () => sendMenu('export-audio') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendMenu('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => sendMenu('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Composite', accelerator: '1', click: () => sendMenu('view:composite'), registerAccelerator: false },
        { label: 'Alpha Matte', accelerator: '2', click: () => sendMenu('view:alpha'), registerAccelerator: false },
        { label: 'Overlay Review', accelerator: '3', click: () => sendMenu('view:overlay'), registerAccelerator: false },
        { label: 'Audio', accelerator: '4', click: () => sendMenu('view:audio'), registerAccelerator: false },
        { label: 'Split Before/After', accelerator: '5', click: () => sendMenu('view:split'), registerAccelerator: false },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }, { role: 'reload' }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'Shift+/', click: () => sendMenu('shortcuts'), registerAccelerator: false },
        { label: 'Licenses & Credits', click: () => sendMenu('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Native inference host (onnxruntime-node). Started lazily; restarted if it crashes.
let inferProc = null;
function inferenceHost() {
  if (inferProc) return inferProc;
  const modelDir = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'models')
    : path.join(app.getAppPath(), 'public', 'models');
  inferProc = utilityProcess.fork(path.join(__dirname, 'infer.cjs'), [], { serviceName: 'Removeless Inference', stdio: 'inherit' });
  inferProc.postMessage({ type: 'init', modelDir });
  inferProc.on('exit', (code) => {
    if (code) console.error(`[infer] host exited with code ${code}`);
    inferProc = null;
  });
  return inferProc;
}

function registerIpc() {
  ipcMain.on('infer:connect', (e) => {
    const { port1, port2 } = new MessageChannelMain();
    inferenceHost().postMessage({ type: 'port' }, [port1]);
    e.sender.postMessage('infer-port', null, [port2]);
  });

  ipcMain.handle('app:info', () => ({
    selftest: SELFTEST,
    platform: process.platform, arch: process.arch, version: app.getVersion(),
    ffmpeg: ff.ffmpegPath(), formats: Object.fromEntries(Object.entries(ff.FORMATS)
      .filter(([, f]) => !f.platforms || f.platforms.includes(process.platform))
      .map(([k, f]) => [k, { label: f.label, ext: f.ext, alpha: f.alpha, sequence: !!f.sequence, matte: !!f.matte, even: !!f.even }])),
  }));

  ipcMain.handle('dialog:open-media', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video & Audio', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'mxf', 'mts', 'm2ts', 'wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'aif', 'aiff'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return r.canceled ? [] : r.filePaths.map(allow);
  });
  ipcMain.handle('dialog:open-project', async () => {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'Removeless Project', extensions: ['removeless'] }] });
    if (r.canceled) return null;
    const json = JSON.parse(readFileSync(r.filePaths[0], 'utf8'));
    for (const c of json.clips || []) if (c.path) allow(c.path);
    return json;
  });
  ipcMain.handle('dialog:save', async (_e, { defaultName, filters, directory }) => {
    if (directory) {
      const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], buttonLabel: 'Export Here' });
      return r.canceled ? null : path.join(r.filePaths[0], defaultName);
    }
    const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('fs:write', (_e, { file, data }) => {
    writeFileSync(file, Buffer.from(data));
    return file;
  });
  ipcMain.handle('fs:write-temp', (_e, { name, data }) => {
    const dir = path.join(os.tmpdir(), 'removeless');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name}`);
    writeFileSync(file, Buffer.from(data));
    return allow(file);
  });
  ipcMain.handle('media:allow', (_e, p) => (existsSync(p) ? allow(p) : null));
  ipcMain.handle('media:probe', (_e, p) => ff.probe(p));
  ipcMain.handle('media:audio', (_e, { path: p, channels }) => ff.extractAudio(p, channels));
  ipcMain.handle('media:proxy', async (e, p) => allow(await ff.makeProxy(p, (f) => e.sender.send('proxy-progress', { path: p, f }))));

  ipcMain.handle('export:start', (_e, o) => ff.startExport(o));
  ipcMain.handle('export:read', async (_e, id) => {
    const f = await ff.readFrame(id);
    return f ? f.buffer : null;
  });
  ipcMain.handle('export:write', (_e, { id, data }) => ff.writeFrame(id, new Uint8Array(data)));
  ipcMain.handle('export:finish', (_e, id) => ff.finishExport(id));
  ipcMain.handle('export:cancel', (_e, id) => ff.cancelExport(id));
  ipcMain.handle('audio:transcode', (_e, { wav, out, codec }) => ff.transcodeAudio(wav, out, codec));

  ipcMain.handle('selftest:capture', async (_e, name) => {
    const img = await win.webContents.capturePage();
    const file = path.join(SELFTEST.outDir, name);
    writeFileSync(file, img.toPNG());
    return file;
  });
  ipcMain.handle('selftest:done', (_e, report) => {
    writeFileSync(path.join(SELFTEST.outDir, 'report.json'), JSON.stringify(report, null, 2));
    setTimeout(() => app.exit(report.ok ? 0 : 1), 200);
  });
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('win:minimize', () => win?.minimize());
  ipcMain.handle('win:maximize', () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()));
  ipcMain.handle('win:close', () => win?.close());
  ipcMain.handle('win:progress', (_e, f) => win?.setProgressBar(f < 0 ? -1 : f));
}

// macOS "Open With…" / dock drop, and second-instance launches on Windows.
app.on('open-file', (e, p) => {
  e.preventDefault();
  allow(p);
  if (win?.webContents && !win.webContents.isLoading()) win.webContents.send('open-files', [p]);
  else pendingOpen.push(p);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = argv.slice(1).filter((a) => !a.startsWith('-') && existsSync(a));
    files.forEach(allow);
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (files.length) win.webContents.send('open-files', files);
    }
  });

  app.whenReady().then(() => {
    ff.setFfmpegPath(resolveFfmpeg());
    process.argv.slice(1).filter((a) => !a.startsWith('-') && /\.\w{2,5}$/.test(a) && existsSync(a)).forEach((p) => { allow(p); pendingOpen.push(p); });
    registerProtocol();
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (!isMac) app.quit(); });
}
