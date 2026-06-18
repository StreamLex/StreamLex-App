<div align="center">

# Relay

### Live, translated subtitles for your stream — your voice *and* your Discord friends, in real time.

Relay captions what's being said and translates it on the fly, then shows clean
subtitles you drop into **OBS, Streamlabs, XSplit, vMix or Twitch Studio** as a
Browser Source. Reach viewers who don't speak your language — without an interpreter.

<!-- Drop a 15–30s demo GIF here. It's the single most important thing on this page. -->
<!-- ![Relay demo](docs/demo.gif) -->

`Windows desktop app` · `OBS browser-source overlay` · `bring-your-own API key`

</div>

---

## ✨ What it does

- 🎙️ **Captions your own voice** live and translates it into your viewers' language.
- 💬 **Captions your Discord friends** too — even per-person, each with their own name tag and colour.
- 🌍 **40+ languages**, including right-to-left (Arabic, Hebrew).
- ⚡ **Low latency** — captions stream in *while* you talk, not after.
- 🎨 **Fully customizable overlay** — fonts, colours, outline, animation, position, themes — with a live preview.
- 🧩 **Works in any streaming app** via a Browser Source, and can be **controlled from inside OBS** (dock or script).
- 🔒 **Your key, your machine** — speech runs locally; only short text is sent for translation.

---

## 🚀 Quick start

### Option A — Desktop app (easiest, Windows)

> ⏳ **No prebuilt download yet.** A one-click installer will appear on the
> [Releases page](https://github.com/StreamLex/StreamLex-App/releases) once the first
> version is published. Until then, use **Option B** below (or run `npm run dist`
> to build your own `Relay-Setup-x.x.x.exe`).

Once a release is up:
1. Download the latest **`Relay-Setup-x.x.x.exe`** from Releases and run it.
   *(Not code-signed yet, so Windows SmartScreen may say "unknown publisher" —
   click **More info → Run anyway**.)*
2. Paste your **Anthropic API key** into the banner at the top → **Save**.
3. Pick your spoken + target language, click **Go live**, allow the mic.
4. Click **Copy** next to the overlay URL and add it as a **Browser Source** in OBS.

That's it — talk, and translated captions appear on your scene.

### Option B — From source (Windows / macOS / Linux)

```bash
git clone https://github.com/StreamLex/StreamLex-App
cd StreamLex-App
npm install        # desktop app deps (Electron)
npm start          # launches the app
```
Or run just the bridge + use it in your browser (no Electron):
```bash
node relay-bridge.js
# open http://localhost:4455/control  in Chrome/Edge
```

You'll need an **[Anthropic API key](https://console.anthropic.com)** for translation
(you supply and pay for it — usually pennies per stream).

---

## 🎛️ Adding the overlay to OBS

Add a **Browser Source** pointing at `http://localhost:4455/overlay` and keep the
**Transparent** backdrop so captions sit over your scene. The Control window's
**Copy** button gives you the exact URL.

**Control it from inside OBS** (no separate window needed):
- **Dock:** *View → Docks → Custom Browser Docks* → add `http://localhost:4455/control?dock=1`. The whole panel — language + every style option — lives inside OBS.
- **Native dropdowns:** load `relay-obs.lua` via *Tools → Scripts* for language/theme/size controls right in OBS.

Switching the **translated language** anywhere (dock, script, or Control window)
re-languages your whole stream at once.

---

## 💬 Translating Discord

Two ways, depending on what you want:

<details>
<summary><b>Whole call, one caption track</b> — <code>relay-discord.py</code> (no bot)</summary>

Transcribes Discord's audio locally with Whisper (free, offline after first run).

```bash
pip install -r requirements.txt
python relay-discord.py --scan        # finds which device carries Discord audio
python relay-discord.py --lang es --to English --label Discord
```
- Device is **auto-detected** (`--device auto`); `--scan` / `--monitor` help you pick.
- On Windows, double-click `find-discord-device.bat` / `test-discord-audio.bat`.
- `--preroll`, `--model`, `--gpu`, `--loopback` available — see `--help`.
</details>

<details>
<summary><b>Per-person captions</b> — <code>relay-discord-bot.py</code> (Discord bot)</summary>

A bot joins your voice channel and hears **each person separately**, so everyone
gets their own name tag and colour — no audio routing at all.

1. Create a bot at the [Discord Developer Portal](https://discord.com/developers/applications), enable **Server Members Intent**, copy the token into `relay.env` as `DISCORD_BOT_TOKEN=…`.
2. Invite it (OAuth2 → scope `bot`, perms **View Channels** + **Connect**).
3. `pip install -r requirements.txt` (uncomment the bot deps first).
```bash
python relay-discord-bot.py --list-channels
python relay-discord-bot.py --channel <channel-id> --to English
```
Use this **instead of** `relay-discord.py`, not both.
</details>

📖 **Per-OS audio routing, every option, mic tuning, two-PC setups → [USAGE.md](USAGE.md)**

---

## 🛠️ How it works

```
  your mic ─────────▶  Control window ─┐
                       (speech-to-text) │
                                        ├──▶  relay-bridge  ──▶  Overlay
  Discord audio ───▶  transcriber ──────┘     (translation)     (Browser Source in OBS)
```

A tiny local **bridge** (zero dependencies, Node 18+) serves the Control panel and
the Overlay on `localhost`, and relays translated captions to every overlay over
Server-Sent Events. In the desktop app, own-voice speech-to-text runs on a bundled
**whisper.cpp** engine; in a browser it uses the Web Speech API. Translation uses
the Anthropic API (Claude Haiku by default) with caching, retries, and streaming
partial captions for low latency.

---

## 📋 Requirements

- **Desktop app:** Windows 10/11 (own-voice engine is Windows x64 today).
- **From source:** Node.js 18+ · Chrome/Edge for the browser Control window.
- **Translation:** an Anthropic API key.
- **Discord captions:** Python 3.9+ (and a virtual audio cable, or the bot).

---

## ⚠️ Honest limits (it's early — v0.1.0)

- The Windows installer is **not code-signed yet** → expect a SmartScreen warning.
- The bundled own-voice engine is **Windows-only** for now (macOS/Linux fall back to the browser path).
- Captions translate on natural pauses, so there's a short, interpreter-like delay.
- Accuracy drops with loud background music or heavy crosstalk.

See the [roadmap](#-roadmap) for what's next.

---

## 🗺️ Roadmap

- [ ] Code-signed Windows installer + auto-update
- [ ] macOS / Linux own-voice engine
- [ ] App icons & polish
- [ ] Per-person Discord captions without a bot token

---

## 📄 License

Source-available and free to use — but not for resale or redistribution. See [LICENSE](LICENSE).

## 🙌 Feedback

Found a bug or want a feature? Open an [issue](https://github.com/StreamLex/StreamLex-App/issues).
If Relay helps your stream, a ⭐ goes a long way.
