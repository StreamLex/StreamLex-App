#!/usr/bin/env python3
"""
Relay - Discord / app voice transcriber (local Whisper edition)
===============================================================
Captures audio from an input device (e.g. the Voicemeeter / virtual-cable bus
carrying your Discord call), transcribes it locally with faster-whisper - no
cloud, no per-minute cost - and pushes each line to the Relay bridge, which
translates it and shows it on your overlay with its own name tag and colour.

Install:
    pip install -r requirements.txt

NOT SURE WHICH DEVICE CARRIES DISCORD?  This is the usual headache. Two tools:

    python relay-discord.py --scan       # have a friend talk; it finds the device
    python relay-discord.py --monitor    # live level meter to confirm audio

Then run (auto-detect is the default, so --device is optional):
    python relay-discord.py --lang es --to English --label Discord
    python relay-discord.py --device "Voicemeeter Out B1" --lang es --to English

Test the whole pipeline with no audio (just sends one line to the overlay):
    python relay-discord.py --say "Hola, esto es una prueba" --lang es --to English --label Discord

Notes
-----
* This captions the *whole* call as one mixed stream (one name tag). Splitting it
  per-person from audio alone isn't possible - that needs a Discord bot reading
  each user's voice separately.
* First run downloads the chosen Whisper model once, then works fully offline.
"""

import argparse, json, time, threading, queue, urllib.request, sys, math

LANG_NAMES = {
    "en":"English","es":"Spanish","fr":"French","de":"German","it":"Italian",
    "pt":"Portuguese","nl":"Dutch","ru":"Russian","ja":"Japanese","ko":"Korean",
    "zh":"Chinese","ar":"Arabic","hi":"Hindi","pl":"Polish","tr":"Turkish",
    "sv":"Swedish","no":"Norwegian","da":"Danish","fi":"Finnish","el":"Greek",
    "cs":"Czech","uk":"Ukrainian","ro":"Romanian","hu":"Hungarian","th":"Thai",
    "vi":"Vietnamese","id":"Indonesian","he":"Hebrew","ms":"Malay",
}

SR    = 16000
BLOCK = int(SR * 0.03)        # 30 ms frames

# Names that usually carry "what an app is playing" - ranked best-first. Used to
# auto-pick a device and to highlight likely ones in --list-devices / --scan.
CANDIDATE_KEYS = [
    "cable output", "voicemeeter out b", "voicemeeter out", "stereo mix",
    "what u hear", "wave out", "loopback", "blackhole", "monitor", "aux output",
]

# ---------------------------------------------------------------- bridge POST --
def post_caption(bridge, text, src_name, dst, label, channel, seq):
    body = json.dumps({"text":text, "srcName":src_name, "dst":dst,
                       "label":label, "channel":channel, "seq":seq}).encode()
    url = bridge.rstrip("/") + "/caption"
    # Retry a couple of times so a brief bridge restart doesn't drop a line.
    for attempt in range(3):
        req = urllib.request.Request(url, data=body,
                headers={"Content-Type":"application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                r.read()
            return
        except Exception as e:
            if attempt == 2:
                print("  ! could not reach the bridge:", e)
            else:
                time.sleep(0.4 * (attempt + 1))

# ------------------------------------------------------------- device helpers --
def input_devices():
    """Capture-capable devices. On Windows every device is exposed under several
    host APIs (MME / DirectSound / WASAPI) — we keep just MME so the same device
    isn't listed three times and a scan stays fast."""
    import sounddevice as sd
    inp = [(i, d) for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]
    apis = sd.query_hostapis()
    mme = next((i for i, a in enumerate(apis) if a["name"] == "MME"), None)
    if mme is not None:
        mme_inp = [(i, d) for i, d in inp if d["hostapi"] == mme]
        if mme_inp:
            return mme_inp
    return inp

def candidate_rank(name):
    n = name.lower()
    for rank, k in enumerate(CANDIDATE_KEYS):
        if k in n:
            return rank
    return len(CANDIDATE_KEYS) + 1

def resolve_device(spec):
    """Return (index_or_name, display_name, was_auto)."""
    import sounddevice as sd
    spec = "" if spec is None else str(spec).strip()
    if not spec or spec.lower() == "auto":
        cands = sorted(input_devices(), key=lambda t: candidate_rank(t[1]["name"]))
        if cands and candidate_rank(cands[0][1]["name"]) <= len(CANDIDATE_KEYS):
            return cands[0][0], cands[0][1]["name"], True
        di = sd.default.device[0]                       # fall back to system default input
        try:
            return di, sd.query_devices(di)["name"], True
        except Exception:
            return None, "system default", True
    try:
        idx = int(spec)
        return idx, sd.query_devices(idx)["name"], False
    except (ValueError, Exception):
        pass
    for i, d in input_devices():                        # case-insensitive substring match
        if spec.lower() in d["name"].lower():
            return i, d["name"], False
    return spec, spec, False                            # let sounddevice try the raw string

# ---------------------------------------------------------------- VU helpers ---
def db_unit(r):
    """RMS -> 0..1 for a meter (maps roughly -60 dBFS .. 0 dBFS)."""
    db = 20 * math.log10(max(r, 1e-6))
    return max(0.0, min(1.0, (db + 60) / 60))

def bar(u, width=30):
    n = int(min(1.0, max(0.0, u)) * width)
    return "[" + "#" * n + "-" * (width - n) + "]"

# -------------------------------------------------------------- list / scan ----
def list_devices():
    print("\n  Input devices (use the name or the [number] with --device):\n")
    for i, d in input_devices():
        star = "  <- likely Discord" if candidate_rank(d["name"]) <= len(CANDIDATE_KEYS) else ""
        print(f"   [{i:2d}] {d['name']}  ({d['max_input_channels']} ch){star}")
    print("\n  Not sure which one? Run:  python relay-discord.py --scan")
    print("  (then have a friend talk in Discord - it finds the right device).\n")

def scan(seconds=1.6):
    import sounddevice as sd, numpy as np
    print("\n  SCAN - which input carries your Discord audio?")
    print("  >>> Have a friend talk in Discord (or play any sound there) NOW. <<<\n")
    time.sleep(0.6)
    results = []
    for i, d in input_devices():
        peak, q = 0.0, queue.Queue()
        def cb(indata, frames, t, status, _q=q):
            _q.put(float(np.sqrt(np.mean(indata[:, 0] ** 2)) + 1e-12))
        try:
            with sd.InputStream(samplerate=SR, blocksize=BLOCK, channels=1,
                                dtype="float32", device=i, callback=cb):
                t0 = time.time()
                while time.time() - t0 < seconds:
                    try: peak = max(peak, q.get(timeout=seconds))
                    except queue.Empty: break
            u = db_unit(peak)
            print(f"   [{i:2d}] {bar(u, 24)} {int(u*100):3d}%  {d['name'][:38]}")
            results.append((i, d["name"], peak))
        except Exception:
            print(f"   [{i:2d}] {'(busy / unavailable)':<30} {d['name'][:38]}")
    live = sorted((r for r in results if r[2]), key=lambda r: -r[2])
    if live and db_unit(live[0][2]) > 0.12:
        b = live[0]
        print(f"\n  OK  Strongest signal:  [{b[0]}]  {b[1]}")
        print(f"      Start with:  python relay-discord.py --device {b[0]} --lang <code> --to English\n")
    else:
        print("\n  !  No clear signal anywhere. Was Discord actually playing while it scanned?")
        print("     Voicemeeter: set Discord's OUTPUT to a Voicemeeter Input, route that")
        print("     strip to a B bus, then capture 'Voicemeeter Out B1'.\n")

def monitor(spec):
    import sounddevice as sd, numpy as np
    idx, name, auto = resolve_device(spec)
    print(f"\n  MONITOR - device [{idx}] {name}" + ("  (auto)" if auto else ""))
    print("  Watch the bar while Discord plays. Ctrl+C to stop.\n")
    q = queue.Queue()
    def cb(indata, frames, t, status): q.put(indata[:, 0].copy())
    try:
        with sd.InputStream(samplerate=SR, blocksize=BLOCK, channels=1,
                            dtype="float32", device=idx, callback=cb):
            while True:
                b = q.get()
                u = db_unit(float(np.sqrt(np.mean(b ** 2)) + 1e-12))
                tag = "SPEECH " if u > 0.20 else ("quiet  " if u > 0.06 else "silent ")
                sys.stdout.write(f"\r  {bar(u, 30)} {int(u*100):3d}%  {tag}")
                sys.stdout.flush()
    except Exception as e:
        print("  ! could not open device:", e)

# ------------------------------------------------------- optional loopback -----
def start_loopback(spec, audio_q):
    """Capture a speaker's output directly (no routing) via the 'soundcard' lib."""
    try:
        import soundcard as sc
    except ImportError:
        print("  ! --loopback needs the 'soundcard' package:  pip install soundcard")
        sys.exit(1)
    import numpy as np
    spec = "" if spec is None else str(spec).strip()
    spk = sc.default_speaker()
    if spec and spec.lower() != "auto":
        for s in sc.all_speakers():
            if spec.lower() in s.name.lower():
                spk = s; break
    print(f"  loopback capture from speaker: {spk.name}")
    mic = sc.get_microphone(str(spk.id), include_loopback=True)
    def run():
        with mic.recorder(samplerate=SR, channels=1) as rec:
            while True:
                data = rec.record(numframes=BLOCK)
                audio_q.put(np.asarray(data)[:, 0].copy())
    threading.Thread(target=run, daemon=True).start()

# ----------------------------------------------------------------------- main --
def main():
    ap = argparse.ArgumentParser(description="Relay local-Whisper voice transcriber")
    ap.add_argument("--device", help="input device name/number, or 'auto' (default)")
    ap.add_argument("--list-devices", action="store_true", help="show input devices and exit")
    ap.add_argument("--scan", action="store_true", help="find which device carries Discord, then exit")
    ap.add_argument("--monitor", action="store_true", help="live level meter to confirm audio, then exit")
    ap.add_argument("--loopback", action="store_true", help="capture speaker output directly (needs: pip install soundcard)")
    ap.add_argument("--lang", default="auto", help="spoken language code (es, fr, en...) or 'auto'")
    ap.add_argument("--to", default="English", help="translate captions into this language")
    ap.add_argument("--label", default="Discord", help="name tag shown on the overlay")
    ap.add_argument("--channel", default="guest", help="'guest' (coloured) or 'host'")
    ap.add_argument("--bridge", default="http://localhost:4455", help="Relay bridge URL")
    ap.add_argument("--model", default="base",
                    help="whisper model: tiny / base / small / medium / large-v3 (bigger = better + slower)")
    ap.add_argument("--gpu", action="store_true", help="use an NVIDIA GPU (CUDA) instead of CPU")
    ap.add_argument("--threshold", type=float, default=0.0, help="voice level (0 = auto-calibrate)")
    ap.add_argument("--preroll", type=float, default=0.3, help="seconds kept before speech starts (avoids clipping word onsets)")
    ap.add_argument("--say", help="send one line to the bridge and exit (pipeline test, no audio)")
    args = ap.parse_args()

    if args.list_devices: return list_devices()
    if args.scan:         return scan()
    if args.monitor:      return monitor(args.device)

    src_name_fixed = LANG_NAMES.get(args.lang) if args.lang != "auto" else None

    if args.say:
        nm = src_name_fixed or "the source language"
        post_caption(args.bridge, args.say, nm, args.to, args.label, args.channel, int(time.time()*1000))
        print(f"  sent a test line to {args.bridge} - it should appear on your overlay.")
        return

    # Heavy imports deferred so --help / --say / --list-devices stay light.
    import numpy as np
    import sounddevice as sd
    from faster_whisper import WhisperModel

    audio_q = queue.Queue()
    work_q  = queue.Queue()
    counter = [0]

    # ---- pick + open the capture device --------------------------------------
    if args.loopback:
        start_loopback(args.device, audio_q)
        dev_name, was_auto = "speaker loopback", False
        stream_ctx = None
    else:
        device, dev_name, was_auto = resolve_device(args.device)
        print(f"  capture device : [{device}] {dev_name}" + ("   (auto-detected)" if was_auto else ""))
        def cb(indata, frames, time_info, status):
            audio_q.put(indata[:, 0].copy())
        try:
            stream_ctx = sd.InputStream(samplerate=SR, blocksize=BLOCK, channels=1,
                                        dtype="float32", device=device, callback=cb)
            stream_ctx.start()
        except Exception as e:
            print(f"  ! could not open '{dev_name}': {e}")
            print("    Run  python relay-discord.py --scan  to find a working device.")
            return

    dev, compute = ("cuda","float16") if args.gpu else ("cpu","int8")
    print(f"  loading Whisper '{args.model}' on {dev} ({compute}) - first run downloads the model...")
    model = WhisperModel(args.model, device=dev, compute_type=compute)
    print("  model ready.")

    SIL_BLOCKS = int(0.7 / 0.03)   # ~0.7 s of quiet closes an utterance
    MAX_BLOCKS = int(14 / 0.03)    # hard cap so long talkers still flush
    MIN_SEC    = 0.4               # ignore blips shorter than this
    PRE_BLOCKS = int(max(0.0, args.preroll) / 0.03)   # pre-roll so word onsets aren't clipped (--preroll)

    def transcriber():
        while True:
            seg = work_q.get()
            if seg is None: break
            try:
                segments, info = model.transcribe(
                    seg, language=(None if args.lang == "auto" else args.lang),
                    vad_filter=True, beam_size=1)
                text = " ".join(s.text.strip() for s in segments).strip()
                if text:
                    nm = src_name_fixed or LANG_NAMES.get(getattr(info, "language", ""), "the source language")
                    counter[0] += 1
                    seq = int(time.time()*1000) * 1000 + counter[0]
                    print(f"  [{args.label}] {text}")
                    post_caption(args.bridge, text, nm, args.to, args.label, args.channel, seq)
            except Exception as e:
                print("  ! transcription error:", e)
    threading.Thread(target=transcriber, daemon=True).start()

    # ---- auto-calibrate the voice threshold against ~1 s of ambient noise ----
    thr = args.threshold
    if thr <= 0:
        floor, t0 = [], time.time()
        while time.time() - t0 < 1.0:
            try: floor.append(float(np.sqrt(np.mean(audio_q.get(timeout=1) ** 2))))
            except queue.Empty: break
        base = (sum(floor)/len(floor)) if floor else 0.005
        thr = max(base * 3.0, 0.008)
        print(f"  auto voice threshold: {thr:.4f}  (override with --threshold)")

    print("\n  Listening. Translated captions will appear on your overlay. Ctrl+C to stop.")
    print("  (a status line prints every few seconds so you know audio is getting through)\n")

    # ---- main VAD loop + audio-health heartbeat ------------------------------
    triggered, voiced, silence = False, [], 0
    preroll = []
    last_voice = last_status = time.time()
    interval_peak = 0.0
    warned = False
    while True:
        b = audio_q.get()
        level = float(np.sqrt(np.mean(b ** 2)) + 1e-12)
        interval_peak = max(interval_peak, level)
        speech = level > thr

        if not triggered:
            preroll.append(b)                 # keep a rolling pre-roll while quiet
            if len(preroll) > PRE_BLOCKS:
                preroll.pop(0)
            if speech:
                triggered, voiced, silence = True, list(preroll), 0
                preroll = []
        else:
            voiced.append(b)
            silence = 0 if speech else silence + 1
            if silence > SIL_BLOCKS or len(voiced) > MAX_BLOCKS:
                seg = np.concatenate(voiced)
                triggered, voiced, silence = False, [], 0
                if len(seg) / SR >= MIN_SEC:
                    work_q.put(seg)

        now = time.time()
        if speech:
            last_voice, warned = now, False
        if now - last_status >= 8:
            u = db_unit(interval_peak)
            state = "audio OK" if interval_peak > thr else "quiet - no speech yet"
            print(f"  level {bar(u, 20)} {int(u*100):3d}%  {state}")
            last_status, interval_peak = now, 0.0
        if now - last_voice > 20 and not warned:
            print("\n  !  No audio for 20s - Discord may not be routed to this device.")
            print("     Run  python relay-discord.py --scan  to find the right one.\n")
            warned = True

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  stopped.")
