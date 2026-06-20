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
const REL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_REL}`;
// Two prebuilt Windows engines from the same release. The cuBLAS build runs
// inference on an NVIDIA GPU (5-15x faster — medium/large become real-time); the
// plain build is CPU-only. We pick automatically (see detectGpu).
// NOTE: use the CUDA 12.x build — it bundles cuBLAS (cublas64_12 / cublasLt64_12)
// so it's self-contained. The smaller 11.8 build does NOT ship cuBLAS and fails
// to load the GPU backend unless a CUDA Toolkit is already installed.
const BIN = {
  cpu:  { url: `${REL}/whisper-bin-x64.zip`,              label: 'CPU',               mb: 4   },
  cuda: { url: `${REL}/whisper-cublas-12.4.0-bin-x64.zip`, label: 'NVIDIA GPU (CUDA)', mb: 460 }
};
const MODELS = {
  tiny:  { file: 'ggml-tiny.bin',  mb: 75   },
  base:  { file: 'ggml-base.bin',  mb: 148  },
  small: { file: 'ggml-small.bin', mb: 488  },
  medium:{ file: 'ggml-medium.bin', mb: 1530 },
  'large-v3-turbo': { file: 'ggml-large-v3-turbo.bin', mb: 1620 }
};

// Is there a usable NVIDIA GPU? `nvidia-smi` only exists and returns 0 when the
// driver is installed and working — a reliable signal that the CUDA build will
// actually run. Cached; set RELAY_FORCE_CPU=1 to force the CPU build.
let _gpu = null;
function detectGpu(){
  if (_gpu !== null) return _gpu;
  _gpu = false;
  if (process.platform === 'win32' && process.arch === 'x64' && !process.env.RELAY_FORCE_CPU){
    try { cp.execFileSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 4000 }); _gpu = true; } catch(_){}
  }
  return _gpu;
}

// Pick the best model that still keeps LIVE captions snappy — no UI knob. With a
// GPU, large-v3-turbo is BOTH faster and more accurate, so use it. On CPU stay
// light: medium is too slow for live; 'small' is the sweet spot, lighter machines
// step down. Override either way with RELAY_WHISPER_MODEL.
function bestDefaultModel(gpu = detectGpu()){
  if (gpu) return 'large-v3-turbo';
  const cores = os.cpus().length;
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
    this.gpu = detectGpu();                     // NVIDIA GPU present? → use the CUDA build
    this.variant = null;                        // 'cpu' | 'cuda' — which engine is running
    this._binDir = null;                        // resolved folder holding whisper-server.exe
    this.state = 'idle';                       // idle | downloading | starting | ready | error | unsupported
    this.onStatus = () => {};
  }
  unsupported(){ return !(process.platform === 'win32' && process.arch === 'x64'); }
  binDir(){ return this._binDir || path.join(this.dir, 'bin', 'Release'); }
  serverExe(){ return path.join(this.binDir(), 'whisper-server.exe'); }
  // Find the folder that actually contains whisper-server.exe under bin/ (the CPU
  // and CUDA zips both ship a Release/ folder, but locate it to be safe).
  resolveBinDir(){
    const root = path.join(this.dir, 'bin');
    const direct = path.join(root, 'Release', 'whisper-server.exe');
    if (fs.existsSync(direct)){ this._binDir = path.join(root, 'Release'); return this._binDir; }
    const stack = [root];
    while (stack.length){
      const d = stack.pop();
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch(_){ continue; }
      for (const e of entries){
        const p = path.join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.name.toLowerCase() === 'whisper-server.exe'){ this._binDir = d; return d; }
      }
    }
    this._binDir = path.join(root, 'Release'); return this._binDir;
  }
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

  // which engine build is currently installed on disk ('cpu' | 'cuda' | '')
  variantFile(){ return path.join(this.dir, 'engine.txt'); }
  installedVariant(){ try { return fs.readFileSync(this.variantFile(), 'utf8').trim(); } catch(_){ return ''; } }

  async ensure(model, variant){
    fs.mkdirSync(this.dir, { recursive: true });
    // engine binary — (re)install if missing or the variant changed (CPU<->CUDA)
    this.resolveBinDir();
    if (!fs.existsSync(this.serverExe()) || this.installedVariant() !== variant){
      const spec = BIN[variant] || BIN.cpu;
      this.setStatus('downloading', { what: 'engine', pct: 0, mb: spec.mb, engine: spec.label });
      // wipe any previous build so the CPU and CUDA DLLs never mix
      try { fs.rmSync(path.join(this.dir, 'bin'), { recursive: true, force: true }); } catch(_){}
      const zip = path.join(this.dir, 'whisper-bin.zip');
      await downloadFile(spec.url, zip, p => this.setStatus('downloading', { what: 'engine', pct: p, mb: spec.mb, engine: spec.label }));
      // extract with the OS unzip (Electron's bundled extractor is unreliable here)
      cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath ' + JSON.stringify(zip) + ' -DestinationPath ' + JSON.stringify(path.join(this.dir, 'bin')) + ' -Force'],
        { stdio: 'ignore' });
      try { fs.unlinkSync(zip); } catch(_){}
      try { fs.writeFileSync(this.variantFile(), variant); } catch(_){}
      this._binDir = null; this.resolveBinDir();
    }
    // model
    if (!fs.existsSync(this.modelPath(model))){
      this.setStatus('downloading', { what: 'model', pct: 0, mb: MODELS[model].mb });
      await downloadFile(modelUrl(model), this.modelPath(model),
        p => this.setStatus('downloading', { what: 'model', pct: p, mb: MODELS[model].mb }));
    }
  }

  async start(model, opts = {}){
    if (!model) model = this.preferredModel();
    if (!MODELS[model]) model = DEFAULT_MODEL;
    this.model = model;
    if (this.unsupported()){ this.setStatus('unsupported'); return false; }
    const variant = (opts.forceCpu || !this.gpu) ? 'cpu' : 'cuda';
    this.variant = variant;
    try {
      await this.ensure(model, variant);
      this.setStatus('starting', { engine: BIN[variant].label });
      const threads = Math.max(2, Math.min(os.cpus().length, 8));   // CPU threads (also feeds the GPU build)
      // greedy decoding (no beam search) keeps live captions snappy; with the
      // CUDA build the GPU is used automatically (no flag needed).
      const child = cp.spawn(this.serverExe(),
        ['-m', this.modelPath(model), '--host', '127.0.0.1', '--port', String(this.port),
         '-t', String(threads)],
        { cwd: this.binDir(), windowsHide: true });
      this.proc = child;
      // only react to THIS child's exit (a model switch starts a new one)
      child.on('exit', () => { if (this.proc === child){ this.proc = null; if (this.state !== 'idle') this.setStatus('error', { msg: 'engine stopped' }); } });
      await this.waitReady(40000);
      this.setStatus('ready', { engine: BIN[variant].label });
      return true;
    } catch (e){
      // A CUDA build can fail on an old/missing driver — fall back to the CPU
      // build once, and to a CPU-sized model (don't run a large model on CPU).
      if (variant === 'cuda' && !opts.forceCpu){
        try { this.proc && this.proc.kill(); } catch(_){}
        this.proc = null;
        this.setStatus('starting', { engine: 'CPU (GPU unavailable)' });
        const env = process.env.RELAY_WHISPER_MODEL;
        const fb = (env && MODELS[env]) ? env : bestDefaultModel(false);
        return this.start(fb, { forceCpu: true });
      }
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
