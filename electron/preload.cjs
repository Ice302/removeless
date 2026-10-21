// Minimal, explicit bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const fn = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

// Forward the native-inference MessagePort to the page (and from there to the matte worker).
ipcRenderer.on('infer-port', (e) => window.postMessage('removeless:infer-port', '*', e.ports));

contextBridge.exposeInMainWorld('native', {
  connectInference: () => ipcRenderer.send('infer:connect'),
  info: () => ipcRenderer.invoke('app:info'),
  openMediaDialog: () => ipcRenderer.invoke('dialog:open-media'),
  openProjectDialog: () => ipcRenderer.invoke('dialog:open-project'),
  saveDialog: (o) => ipcRenderer.invoke('dialog:save', o),
  writeFile: (file, data) => ipcRenderer.invoke('fs:write', { file, data }),
  writeTemp: (name, data) => ipcRenderer.invoke('fs:write-temp', { name, data }),
  pathForFile: (file) => webUtils.getPathForFile(file),
  allowMedia: (p) => ipcRenderer.invoke('media:allow', p),
  probe: (p) => ipcRenderer.invoke('media:probe', p),
  extractAudio: (p, channels) => ipcRenderer.invoke('media:audio', { path: p, channels }),
  makeProxy: (p) => ipcRenderer.invoke('media:proxy', p),
  exportStart: (o) => ipcRenderer.invoke('export:start', o),
  exportRead: (id) => ipcRenderer.invoke('export:read', id),
  exportWrite: (id, data) => ipcRenderer.invoke('export:write', { id, data }),
  exportFinish: (id) => ipcRenderer.invoke('export:finish', id),
  exportCancel: (id) => ipcRenderer.invoke('export:cancel', id),
  transcodeAudio: (wav, out, codec) => ipcRenderer.invoke('audio:transcode', { wav, out, codec }),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximize: () => ipcRenderer.invoke('win:maximize'),
  close: () => ipcRenderer.invoke('win:close'),
  setProgress: (f) => ipcRenderer.invoke('win:progress', f),
  selftestCapture: (name) => ipcRenderer.invoke('selftest:capture', name),
  selftestDone: (report) => ipcRenderer.invoke('selftest:done', report),
  onMenu: on('menu'),
  onOpenFiles: on('open-files'),
  onProxyProgress: on('proxy-progress'),
  onWindowState: on('window-state'),
});
