// Minimal, safe bridge between the renderer (control panel) and Electron.
// contextIsolation is on; we only expose a tiny, explicit surface.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('relayDesktop', {
  isDesktop: true,
  electron: process.versions.electron,

  // own-voice speech engine (whisper.cpp, runs in the main process)
  whisperState: () => ipcRenderer.invoke('whisper:state'),
  // pcm: Float32Array; we hand its ArrayBuffer to the main process
  transcribe: (pcm, sampleRate, lang) =>
    ipcRenderer.invoke('whisper:transcribe', { pcm: pcm.buffer, sampleRate, lang }),
  onWhisperStatus: cb => ipcRenderer.on('whisper:status', (_e, s) => cb(s))
});
