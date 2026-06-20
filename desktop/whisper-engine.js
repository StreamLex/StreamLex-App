// whisper.cpp engine for own-voice captions inside the desktop app.
// Replaces the browser Web Speech API (which doesn't work in Electron).
//
// On first run it downloads a small whisper.cpp binary + model into the app's
// user-data folder, runs `whisper-server` (loads the model once), and exposes a
// transcribe(pcm) that POSTs an utterance to the server's /inference endpoint.
//
// Windows x64 is supported today (uses the official prebuilt binary). Other
// platforms report unsupported() and the app falls back to the browser path.
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const cp   = require('child_process');

const WHISPER_REL = 'v1.8.7';
const BIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_REL}/whisper-bin-x64.zip`;
const MODELS = {
  tiny:  { file: 'ggml-tiny.bin',  mb: 75   },
  base:  { file: 'ggml-base.bin',  mb: 148  },
  small: { file: 'ggml-small.bin', mb: 488  },
  medium:{ file: 'ggml-medium.bin', mb: 1530 },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', mb: 1620 }
};
// Pick the best model the machine can run while staying snappy for LIVE captions —
// no UI knob. 'small' is the sweet spot (fast + good multilingual accuracy); lighter
// machines step down. Heavier models exist but add too much latency for live use
// (override with RELAY_WHISPER_MODEL if you ever want max accuracy over speed).
function bestDefaultModel(){
  const cores = os.cpus().length;
  if (cores >= 8) return 'medium';  // more accurate, kept direct via greedy decoding
  if (cores >= 6) return 'small';
  if (cores >= 4) return 'base';
  return 'tiny';
}
const DEFAULT_MODEL = bestDefaultModel();
const modelUrl = name => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODELS[name].file}?download=true`;

function downloadFile(url, dest, onProgress, redirects = 0){
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    const tmp = dest + '.part';
    const req = https.get(url, { headers: { 'User-Agent': 'relay' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location){
        res.resume();
        return resolve(downloadFile(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' for ' + url)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const out = fs.createWriteStream(tmp);
      res.on('data', c => { got += c.length; if (onProgress && total) onProgress(got / total); });
      res.pipe(out);
      out.on('finish', () => out.close(() => { try { fs.renameSync(tmp, dest); resolve(); } catch(e){ reject(e); } }));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

class WhisperEngine {
  constructor(dataDir){
    this.dir = path.join(dataDir, 'whisper');
    this.port = 8910;
    this.proc = null;
    this.model = null;
    this.state = 'idle';                       // idle | downloading | starting | ready | error | unsupported
    this.onStatus = () => {};
  }
  unsupported(){ return !(process.platform === 'win32' && process.arch === 'x64'); }
  binDir(){ return path.join(this.dir, 'bin', 'Release'); }
  serverExe(){ return path.join(this.binDir(), 'whisper-server.exe'); }
  modelPath(name){ return path.join(this.dir, MODELS[name].file); }
  setStatus(state, extra){ this.state = state; try { this.onStatus({ state, model: this.model, ...extra }); } catch(_){} }

  // remember the user's chosen quality (model) across launches
  modelFile(){ return path.join(this.dir, 'model.txt'); }
  preferredModel(){
    const env = process.env.RELAY_WHISPER_MODEL;                 // optional override, no UI
    if (env && MODELS[env]) return env;
    try { const m = fs.readFileSync(this.modelFile(), 'utf8').trim(); if (MODELS[m]) return m; } catch(_){}
    return DEFAULT_MODEL;
  }
  savePreferred(name){ try { fs.mkdirSync(this.dir, { recursive: true }); fs.writeFileSync(this.modelFile(), name); } catch(_){} }
  async setModel(name){
    if (!MODELS[name]) return false;
    this.savePreferred(name);
    if (name === this.model && this.state === 'ready') return true;
    this.stop();
    return this.start(name);
  }

  async ensure(model){
    fs.mkdirSync(this.dir, { recursive: true });
    // binary
    if (!fs.existsSync(this.serverExe())){
      this.setStatus('downloading', { what: 'engine', pct: 0 });
      const zip = path.join(this.dir, 'whisper-bin.zip');
      await downloadFile(BIN_URL, zip, p => this.setStatus('downloading', { what: 'engine', pct: p }));
      // extract with the OS unzip (Electron's bundled extractor is unreliable here)
      cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath ' + JSON.stringify(zip) + ' -DestinationPath ' + JSON.stringify(path.join(this.dir, 'bin')) + ' -Force'],
        { stdio: 'ignore' });
      try { fs.unlinkSync(zip); } catch(_){}
    }
    // model
    if (!fs.existsSync(this.modelPath(model))){
      this.setStatus('downloading', { what: 'model', pct: 0, mb: MODELS[model].mb });
      await downloadFile(modelUrl(model), this.modelPath(model),
        p => this.setStatus('downloading', { what: 'model', pct: p, mb: MODELS[model].mb }));
    }
  }

  async start(model){
    if (!model) model = this.preferredModel();
    if (!MODELS[model]) model = DEFAULT_MODEL;
    this.model = model;
    if (this.unsupported()){ this.setStatus('unsupported'); return false; }
    try {
      await this.ensure(model);
      this.setStatus('starting');
      const threads = Math.max(2, Math.min(os.cpus().length, 8));   // more threads = faster inference
      // greedy decoding (no beam search) keeps live captions snappy; the model
      // size carries the accuracy.
      const child = cp.spawn(this.serverExe(),
        ['-m', this.modelPath(model), '--host', '127.0.0.1', '--port', String(this.port),
         '-t', String(threads)],
        { cwd: this.binDir(), windowsHide: true });
      this.proc = child;
      // only react to THIS child's exit (a model switch starts a new one)
      child.on('exit', () => { if (this.proc === child){ this.proc = null; if (this.state !== 'idle') this.setStatus('error', { msg: 'engine stopped' }); } });
      await this.waitReady(40000);
      this.setStatus('ready');
      return true;
    } catch (e){
      this.setStatus('error', { msg: e.message });
      return false;
    }
  }

  waitReady(timeout){
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        const req = http.get({ host: '127.0.0.1', port: this.port, path: '/', timeout: 1500 }, res => {
          res.resume(); resolve();
        });
        req.on('error', () => {
          if (Date.now() - t0 > timeout) return reject(new Error('engine did not start in time'));
          setTimeout(tick, 600);
        });
        req.on('timeout', () => { req.destroy(); });
      };
      tick();
    });
  }

  // pcm: Float32Array mono @ sampleRate. Returns recognised text ('' if none).
  transcribe(pcm, sampleRate, lang){
    const wav = encodeWav(pcm, sampleRate);
    const boundary = '----relay' + Date.now().toString(16);
    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
    parts.push(wav);
    let tail = `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\ntext\r\n`;
    if (lang && lang !== 'auto')
      tail += `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${lang}\r\n`;
    tail += `--${boundary}--\r\n`;
    parts.push(Buffer.from(tail));
    const body = Buffer.concat(parts);
    return new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: this.port, path: '/inference', method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } },
        res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(cleanText(d))); });
      req.on('error', () => resolve(''));
      req.write(body); req.end();
    });
  }

  stop(){ this.setStatus('idle'); if (this.proc){ try { this.proc.kill(); } catch(_){} this.proc = null; } }
}

// whisper sometimes wraps output in brackets / adds [BLANK_AUDIO]; tidy it.
function cleanText(s){
  s = (s || '').trim();
  if (/^\[.*\]$/.test(s) || /\[BLANK_AUDIO\]|\(.*silence.*\)/i.test(s)) return '';
  return s.replace(/\s+/g, ' ').trim();
}

function encodeWav(float32, sampleRate){
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++){ let s = Math.max(-1, Math.min(1, float32[i])); buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7FFF) | 0, o); o += 2; }
  return buf;
}

module.exports = { WhisperEngine, encodeWav };
