#!/usr/bin/env python3
"""
Relay - Discord BOT transcriber (per-person captions)
=====================================================
Unlike relay-discord.py (which captions the whole call as one mixed stream), this
joins your voice channel as a bot and receives EACH person's voice separately, so
every friend gets their own name tag and colour on the overlay - automatically.

It needs a (free) bot token and one-time setup. Worth it if you want per-speaker
captions. If you just want "the call" captioned, relay-discord.py is simpler.

--------------------------------------------------------------------------------
ONE-TIME SETUP
--------------------------------------------------------------------------------
1) Create a bot + get a token:
   - Go to https://discord.com/developers/applications  ->  New Application
   - Left sidebar "Bot"  ->  Reset Token  ->  copy it
   - On that Bot page, turn ON  "SERVER MEMBERS INTENT"  (so names resolve)
   - Save the token in relay.env (next to this file):
         DISCORD_BOT_TOKEN=your-token-here

2) Invite the bot to YOUR server:
   - Left sidebar "OAuth2" -> "URL Generator"
   - Scopes: check  "bot"
   - Bot permissions: check  "View Channels"  and  "Connect"
   - Open the generated URL, pick your server, Authorize.

3) Install the extra deps (one time):
         pip install -r requirements.txt
   (this adds discord.py, discord-ext-voice-recv and PyNaCl)

--------------------------------------------------------------------------------
RUN
--------------------------------------------------------------------------------
List the voice channels the bot can see (find the channel ID):
    python relay-discord-bot.py --list-channels

Join a channel and start captioning everyone in it:
    python relay-discord-bot.py --channel 123456789012345678 --to English

    --channel  voice channel ID (right-click the channel -> Copy Channel ID;
               enable Developer Mode in Discord settings to see that option),
               or part of the channel name.
    --to       language to translate captions into (match your viewers)
    --lang     spoken language code or 'auto' (default: auto-detect per person)
    --model    tiny / base / small / medium / large-v3   (default: base)
    --gpu      use an NVIDIA GPU (CUDA) instead of CPU
    --bridge   Relay bridge URL (default http://localhost:4455)
"""

import argparse, os, json, time, threading, queue, urllib.request, sys

LANG_NAMES = {
    "en":"English","es":"Spanish","fr":"French","de":"German","it":"Italian",
    "pt":"Portuguese","nl":"Dutch","ru":"Russian","ja":"Japanese","ko":"Korean",
    "zh":"Chinese","ar":"Arabic","hi":"Hindi","pl":"Polish","tr":"Turkish",
    "sv":"Swedish","no":"Norwegian","da":"Danish","fi":"Finnish","el":"Greek",
    "cs":"Czech","uk":"Ukrainian","ro":"Romanian","hu":"Hungarian","th":"Thai",
    "vi":"Vietnamese","id":"Indonesian","he":"Hebrew","ms":"Malay",
}

# Discord delivers 48 kHz, 16-bit, stereo PCM in 20 ms frames.
DISCORD_SR = 48000
TARGET_SR  = 16000          # what Whisper wants
GAP_SEC    = 0.7            # silence (no packets) that closes someone's utterance
MIN_SEC    = 0.4            # ignore blips shorter than this
MAX_SEC    = 14.0           # hard cap so long talkers still flush


def load_env():
    """Load relay.env so DISCORD_BOT_TOKEN can live there with the API key."""
    here = os.path.dirname(os.path.abspath(__file__))
    for name in ("relay.env", ".env"):
        try:
            with open(os.path.join(here, name), "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k, v = k.strip(), v.strip().strip('"').strip("'")
                    os.environ.setdefault(k, v)
        except FileNotFoundError:
            pass


def post_caption(bridge, text, src_name, dst, label, channel, seq):
    body = json.dumps({"text":text, "srcName":src_name, "dst":dst,
                       "label":label, "channel":channel, "seq":seq}).encode()
    url = bridge.rstrip("/") + "/caption"
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


def main():
    ap = argparse.ArgumentParser(description="Relay per-person Discord bot transcriber")
    ap.add_argument("--channel", help="voice channel ID (or part of its name)")
    ap.add_argument("--list-channels", action="store_true", help="list voice channels the bot can see, then exit")
    ap.add_argument("--token", help="bot token (or DISCORD_BOT_TOKEN in relay.env)")
    ap.add_argument("--to", default="English", help="translate captions into this language")
    ap.add_argument("--lang", default="auto", help="spoken language code or 'auto'")
    ap.add_argument("--model", default="small", help="whisper model: tiny/base/small/medium/large-v3 (bigger = more accurate)")
    ap.add_argument("--gpu", action="store_true", help="use an NVIDIA GPU (CUDA) instead of CPU")
    ap.add_argument("--bridge", default="http://localhost:4455", help="Relay bridge URL")
    args = ap.parse_args()

    load_env()
    token = args.token or os.environ.get("DISCORD_BOT_TOKEN", "")
    if not token:
        print("  No bot token. Put DISCORD_BOT_TOKEN=... in relay.env, or pass --token.")
        print("  See the setup steps at the top of this file.")
        return

    # Imports deferred so --help stays light and errors are friendly.
    try:
        import numpy as np
        import discord
        from discord.ext import voice_recv
        from faster_whisper import WhisperModel
    except ImportError as e:
        print("  ! Missing dependency:", e)
        print("    Install the bot deps with:  pip install -r requirements.txt")
        print("    (needs discord.py, discord-ext-voice-recv, PyNaCl, faster-whisper)")
        return

    intents = discord.Intents.default()
    intents.members = True            # to resolve display names (enable in dev portal)
    intents.voice_states = True
    client = discord.Client(intents=intents)

    src_name_fixed = LANG_NAMES.get(args.lang) if args.lang != "auto" else None

    # ---- Whisper worker: utterances come in as (display_name, float32@16k) ----
    work_q = queue.Queue()
    counter = [0]
    dev, compute = ("cuda","float16") if args.gpu else ("cpu","int8")
    print(f"  loading Whisper '{args.model}' on {dev} ({compute}) - first run downloads it...")
    model = WhisperModel(args.model, device=dev, compute_type=compute)
    print("  model ready.")

    def worker():
        while True:
            item = work_q.get()
            if item is None:
                break
            name, audio = item
            try:
                segments, info = model.transcribe(
                    audio, language=(None if args.lang == "auto" else args.lang),
                    vad_filter=True, beam_size=5)
                text = " ".join(s.text.strip() for s in segments).strip()
                if text:
                    nm = src_name_fixed or LANG_NAMES.get(getattr(info, "language", ""), "the source language")
                    counter[0] += 1
                    seq = int(time.time()*1000) * 1000 + counter[0]
                    print(f"  [{name}] {text}")
                    post_caption(args.bridge, text, nm, args.to, name, "guest", seq)
            except Exception as e:
                print("  ! transcription error:", e)
    threading.Thread(target=worker, daemon=True).start()

    # ---- per-user PCM buffers, flushed when a person stops talking ----------
    buffers = {}          # user_id -> {"name":str, "chunks":[np.int16], "last":float}
    lock = threading.Lock()

    def flush(uid, state):
        raw = np.concatenate(state["chunks"]) if state["chunks"] else np.array([], np.int16)
        if raw.size == 0:
            return
        # stereo int16 -> mono float32, then 48k -> 16k by /3 decimation
        stereo = raw.reshape(-1, 2).astype(np.float32) / 32768.0
        mono = stereo.mean(axis=1)
        mono16 = mono[::3]
        if len(mono16) / TARGET_SR >= MIN_SEC:
            work_q.put((state["name"], mono16))

    def reaper():
        while True:
            time.sleep(0.1)
            now = time.time()
            with lock:
                for uid in list(buffers):
                    st = buffers[uid]
                    dur = sum(len(c) for c in st["chunks"]) / 2 / DISCORD_SR
                    if (now - st["last"] > GAP_SEC and st["chunks"]) or dur >= MAX_SEC:
                        flush(uid, st)
                        st["chunks"] = []
    threading.Thread(target=reaper, daemon=True).start()

    class Sink(voice_recv.AudioSink):
        def wants_opus(self): return False        # give us decoded PCM
        def write(self, user, data):
            if user is None:
                return
            pcm = np.frombuffer(data.pcm, dtype=np.int16)
            with lock:
                st = buffers.get(user.id)
                if st is None:
                    st = buffers[user.id] = {"name": getattr(user, "display_name", str(user)),
                                             "chunks": [], "last": time.time()}
                st["name"] = getattr(user, "display_name", st["name"])
                st["chunks"].append(pcm)
                st["last"] = time.time()
        def cleanup(self):
            with lock:
                for uid, st in buffers.items():
                    flush(uid, st)
                    st["chunks"] = []

    def find_voice_channels():
        out = []
        for g in client.guilds:
            for ch in g.voice_channels:
                out.append((g, ch))
        return out

    @client.event
    async def on_ready():
        print(f"  connected as {client.user}.")
        chans = find_voice_channels()
        if args.list_channels:
            print("\n  Voice channels the bot can see:\n")
            for g, ch in chans:
                print(f"   [{ch.id}]  {g.name}  /  #{ch.name}")
            print("\n  Run with:  python relay-discord-bot.py --channel <ID> --to English\n")
            await client.close(); return

        if not args.channel:
            print("  Pick a channel with --channel (run --list-channels to see IDs).")
            await client.close(); return

        target = None
        for g, ch in chans:
            if str(ch.id) == str(args.channel) or args.channel.lower() in ch.name.lower():
                target = ch; break
        if target is None:
            print(f"  Could not find voice channel '{args.channel}'. Try --list-channels.")
            await client.close(); return

        try:
            vc = await target.connect(cls=voice_recv.VoiceRecvClient)
        except Exception as e:
            print("  ! could not join the channel:", e)
            await client.close(); return
        vc.listen(Sink())
        print(f"  joined  {target.guild.name} / #{target.name}  - captioning everyone. Ctrl+C to stop.\n")

    try:
        client.run(token)
    except KeyboardInterrupt:
        print("\n  stopped.")
    except Exception as e:
        msg = str(e)
        if "intents" in msg.lower() or "privileged" in msg.lower():
            print("  ! Discord rejected the connection - enable SERVER MEMBERS INTENT on your")
            print("    bot's page (Developer Portal -> your app -> Bot), then try again.")
        else:
            print("  ! bot error:", msg)


if __name__ == "__main__":
    main()
