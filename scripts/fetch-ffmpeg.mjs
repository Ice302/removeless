// Downloads static ffmpeg builds for each target into vendor/ffmpeg/<platform>-<arch>/
// so electron-builder can bundle the right binary per installer.
// Usage: node scripts/fetch-ffmpeg.mjs [darwin-arm64 darwin-x64 win32-x64 linux-x64]
import { createWriteStream, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import path from 'node:path';

const RELEASE = 'b6.1.1';
const BASE = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE}`;
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [`${process.platform}-${process.arch}`];

for (const target of targets) {
  const [platform] = target.split('-');
  const dir = path.resolve('vendor/ffmpeg', target);
  const exe = path.join(dir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (existsSync(exe) && statSync(exe).size > 1e6) {
    console.log(`✓ ${target} already present`);
    continue;
  }
  mkdirSync(dir, { recursive: true });
  for (const [name, dest, gz] of [
    [`ffmpeg-${target}.gz`, exe, true],
    [`${target}.LICENSE`, path.join(dir, 'LICENSE.txt'), false],
  ]) {
    const res = await fetch(`${BASE}/${name}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    const body = Readable.fromWeb(res.body);
    await (gz ? pipeline(body, createGunzip(), createWriteStream(dest)) : pipeline(body, createWriteStream(dest)));
  }
  if (platform !== 'win32') chmodSync(exe, 0o755);
  console.log(`✓ ${target} → ${exe}`);
}
