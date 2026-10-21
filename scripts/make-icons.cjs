// Rasterises public/icon.svg into the app/PWA icons using Electron's renderer.
// Usage: npx electron scripts/make-icons.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'public/icon.svg'), 'utf8');
const targets = [['build/icon.png', 1024], ['public/icon-512.png', 512]];

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<canvas></canvas>');
  for (const [file, size] of targets) {
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((res) => {
      const img = new Image();
      img.onload = () => { const c = document.querySelector('canvas'); c.width = c.height = ${size};
        c.getContext('2d').drawImage(img, 0, 0, ${size}, ${size}); res(c.toDataURL('image/png')); };
      img.src = 'data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}';
    })`);
    fs.writeFileSync(path.join(root, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`wrote ${file} (${size}px)`);
  }
  app.quit();
});
