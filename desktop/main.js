// Relay desktop app — Electron wrapper around the local bridge.
// It starts the existing zero-dependency bridge on localhost so the OBS browser
// source keeps working exactly as before, and shows the Control panel in a window.
const { app, BrowserWindow, Menu, shell, clipboard, ipcMain } = require('electron');
const path = require('path');
const { WhisperEngine } = require('./whisper-engine');

const PORT = 4455;
const WHISPER_MODEL = 'base';   // tiny | base | small  (own-voice accuracy vs speed/size)

// The packaged app folder is read-only, so point the bridge's writable files
// (relay.env, relay-config.json) at a per-user data directory. Must be set
// BEFORE requiring the bridge.
process.env.RELAY_DATA_DIR = app.getPath('userData');
process.env.RELAY_PORT = String(PORT);
process.env.RELAY_HOST = '127.0.0.1';

// Start the bridge inside this process (serves /control and /overlay, relays captions).
require(path.join(__dirname, '..', 'relay-bridge.js'));

// Own-voice speech-to-text engine (whisper.cpp) — replaces the browser Web Speech
// API, which doesn't work inside Electron.
const whisper = new WhisperEngine(app.getPath('userData'));

const CONTROL_URL = `http://127.0.0.1:${PORT}/control`;
const OVERLAY_URL = `http://127.0.0.1:${PORT}/overlay`;

let win = null;

function createWindow(){
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 760, minHeight: 560,
    backgroundColor: '#0b0e13',
    title: 'Relay',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadURL(CONTROL_URL);
  win.on('closed', () => { win = null; });
  // relay engine status (download progress / ready) to the control panel
  whisper.onStatus = s => { if (win && !win.isDestroyed()) win.webContents.send('whisper:status', s); };
}

function buildMenu(){
  const template = [
    { label: 'Relay', submenu: [
      // Own-voice runs on the bundled whisper.cpp engine in-app; this is just a
      // convenience if you'd rather drive the panel from a separate browser window.
      { label: 'Open Control in browser', click: () => shell.openExternal(CONTROL_URL) },
      { label: 'Open Overlay in browser', click: () => shell.openExternal(OVERLAY_URL) },
      { label: 'Copy overlay URL for OBS', click: () => clipboard.writeText(OVERLAY_URL) },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'quit' }
    ]},
    { role: 'editMenu' },
    { role: 'viewMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  // ---- own-voice speech IPC (renderer ↔ whisper.cpp engine) ----
  ipcMain.handle('whisper:state', () => whisper.state);
  ipcMain.handle('whisper:transcribe', async (_e, { pcm, sampleRate, lang }) => {
    if (whisper.state !== 'ready') return '';
    return whisper.transcribe(new Float32Array(pcm), sampleRate, lang);
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();

    // Download (first run) + launch the speech engine in the background.
    whisper.start(WHISPER_MODEL).catch(() => {});

    // Auto-update only matters in a packaged, signed build; ignore failures in dev.
    if (app.isPackaged) {
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      } catch (_) {}
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => whisper.stop());
  app.on('window-all-closed', () => {
    whisper.stop();
    if (process.platform !== 'darwin') app.quit();
  });
}
