#!/usr/bin/env node
/*
 * repair-electron — runs automatically after `npm install` (postinstall).
 *
 * Electron's own installer downloads its prebuilt binary to a cache zip and then
 * extracts it with `extract-zip`. On some setups (e.g. newer Node on Windows)
 * that extractor silently bails after one entry, leaving a broken `dist/` with no
 * `electron.exe` — so `electron .` throws "Electron failed to install correctly".
 *
 * The download itself is fine. This script detects the broken state and re-extracts
 * the already-downloaded cache zip using the OS's reliable unzip (Expand-Archive on
 * Windows, `unzip` on macOS/Linux). It is a no-op when Electron installed correctly.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const elDir = path.join(__dirname, '..', 'node_modules', 'electron');
let version;
try { version = require(path.join(elDir, 'package.json')).version; }
catch { process.exit(0); }                       // electron not a dependency here

const platform = process.platform;               // win32 | darwin | linux
const arch = process.arch;                       // x64 | arm64
const dist = path.join(elDir, 'dist');

const binRel  = platform === 'win32'  ? 'electron.exe'
              : platform === 'darwin' ? 'Electron.app'
              :                         'electron';
const pathTxt = platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : binRel;
const binPath = path.join(dist, binRel);

if (fs.existsSync(binPath)) process.exit(0);     // healthy install — nothing to do

console.log('[repair-electron] Electron binary missing — re-extracting from cache…');

const cacheRoot = platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron', 'Cache')
  : platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Caches', 'electron')
  : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'electron');

const zipName = `electron-v${version}-${platform}-${arch}.zip`;
function findZip(dir){
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries){
    const p = path.join(dir, e.name);
    if (e.isDirectory()){ const r = findZip(p); if (r) return r; }
    else if (e.name === zipName) return p;
  }
  return null;
}

const zip = findZip(cacheRoot);
if (!zip){
  console.error('[repair-electron] cached ' + zipName + ' not found under ' + cacheRoot);
  console.error('  Re-run `npm install` with an internet connection so Electron can download.');
  process.exit(1);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

try {
  if (platform === 'win32'){
    cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath ' + JSON.stringify(zip) + ' -DestinationPath ' + JSON.stringify(dist) + ' -Force'],
      { stdio: 'inherit' });
  } else {
    cp.execFileSync('unzip', ['-o', '-q', zip, '-d', dist], { stdio: 'inherit' });
  }
} catch (e){
  console.error('[repair-electron] extraction failed:', e.message);
  process.exit(1);
}

if (!fs.existsSync(binPath)){
  console.error('[repair-electron] binary still missing after re-extract.');
  process.exit(1);
}
fs.writeFileSync(path.join(elDir, 'path.txt'), pathTxt);
console.log('[repair-electron] Electron repaired ✓');
