# Relay — full setup & reference

The [README](README.md) covers the quick start. This is the detailed guide.

## Getting your API key into the bridge

- **In the Control window:** start the bridge, open the Control window, paste your
  Anthropic key into the banner, click **Save**. It's validated and stored.
- **In a file:** copy `relay.env.example` to `relay.env` and put your key inside.
  The bridge loads it on startup (`relay.env` is git-ignored).
- **Inline:**
  ```bash
  # mac / linux
  ANTHROPIC_API_KEY=sk-ant-xxxx node relay-bridge.js
  # windows (cmd)
  set ANTHROPIC_API_KEY=sk-ant-xxxx&& node relay-bridge.js
  ```

## Routing Discord audio to a capture device

Needed only for `relay-discord.py` (the no-bot method). Pick your OS:

- **Windows** — install **VB-Audio Virtual Cable** (free). In Discord:
  *User Settings → Voice & Video → Output Device = "CABLE Input"*. To still hear
  your friends, monitor that cable in Windows/OBS or use VoiceMeeter. Capture device
  is **"CABLE Output"**. (On VoiceMeeter: send Discord's output to a Voicemeeter
  Input strip, route it to a **B bus**, capture **"Voicemeeter Out B1"**.)
- **macOS** — install **BlackHole (2ch)** (free). Make a *Multi-Output Device* in
  Audio MIDI Setup with BlackHole **and** your headphones, set Discord's output to
  it. Capture device is **"BlackHole 2ch"**.
- **Linux (PulseAudio/PipeWire)** — use the `.monitor` source of the sink Discord
  plays to (see `pavucontrol → Recording`, or `--list-devices`).

**Don't guess the device** — have a friend talk and run:
```bash
python relay-discord.py --scan      # reports which input carries the audio
python relay-discord.py --monitor   # live level meter to confirm
```

### `relay-discord.py` options
- `--device`     device name/number, or `auto` (default)
- `--lang`       spoken language code (`es`, `fr`, `ja`…) or `auto`
- `--to`         language to translate into
- `--label`      name tag shown on the overlay
- `--preroll`    seconds kept before speech starts (default `0.3`; raise if first words clip)
- `--model`      `tiny` / `base` / `small` / `medium` / `large-v3`
- `--gpu`        use an NVIDIA GPU instead of CPU
- `--loopback`   capture speaker output directly, no routing (`pip install soundcard`)
- `--say "…"`    push one test line to the overlay (no audio needed)

## Overlay options (URL query params — the Control window sets these for you)
`size` s/m/l/xl · `pos` top/center/bottom · `bg` transparent/studio/chroma ·
`src` on/off (original line) · `plate` on/off · `hold` ms before fade (0 = keep) ·
`lines` max captions on screen · `clean` on/off (mask strong language) ·
`bridge` full bridge URL for 2-PC setups.

Captions stream in as they're translated, stay crisp over any video via a true
text outline, handle right-to-left languages, and give each Discord speaker their
own colour. The Control window has theme presets plus a **Customize** panel
(fonts, colours, outline, animation, spacing) with a live preview.

## Mic tuning (desktop app)
Under **Go live** there's a **Mic tuning** panel for the in-app voice:
- **Word-start buffer** (pre-roll) — raise if first words get clipped.
- **End-of-phrase pause** — lower for snappier captions, higher for fewer cut-offs.
- **Sensitivity** — High picks up soft speech (and more noise).

## Control from inside OBS
- **Dock:** *View → Docks → Custom Browser Docks* → `http://localhost:4455/control?dock=1`
- **Script:** load `relay-obs.lua` via *Tools → Scripts* for native dropdowns.

## Two-PC setup (capture PC + streaming PC)
Run the bridge with `--host=0.0.0.0`, then point the streaming PC's Browser Source
at the capture PC, e.g.
`http://192.168.1.20:4455/overlay?bridge=http://192.168.1.20:4455`.

## Bridge options
```
node relay-bridge.js --port=4455 --host=127.0.0.1 --model=claude-haiku-4-5-20251001
```
Haiku is the low-latency default; a larger `--model` raises quality at slightly more
latency. The bridge caches translations, retries the API on hiccups, remembers your
overlay look across restarts, and replays the last few captions to any overlay you
add mid-stream.

## Building the desktop app
See [desktop/README.md](desktop/README.md) for dev run, building installers, and
release/auto-update setup.
