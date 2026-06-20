# Changelog

All notable changes to **Relay** are documented here.
This project follows [Keep a Changelog](https://keepachangelog.com/) and
[Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-06-20

### Added
- **GPU-accelerated transcription.** On machines with an NVIDIA GPU, Relay now
  runs speech recognition on the GPU (CUDA build of whisper.cpp) — roughly
  **5–15× faster** than the CPU, so live captioning keeps up in real time.
- **Best model by default.** With a GPU, Relay uses `large-v3-turbo` (its most
  accurate multilingual model) at real-time speed — no quality setting to pick.
- **Automatic CPU fallback.** No GPU or an unsupported driver falls back to the
  CPU build with a lighter model, so captions always work.
- Optional overrides: `RELAY_WHISPER_MODEL` to pin a model, `RELAY_FORCE_CPU=1`
  to force the CPU engine.

### Changed
- Smoother live captions: interim results now process only the most recent
  speech instead of re-running the whole sentence each time.

### Fixed
- **Release pipeline now publishes installers.** Tagged releases previously
  produced no downloadable build (the macOS job failed and cancelled Windows,
  and the workflow token couldn't create the release). Releases are now
  Windows-only, published as full releases, with the right permissions — so
  `Relay-Setup-x.y.z.exe` and auto-update metadata ship correctly.

## [0.2.0] — 2026-06-19

### Added
- Automatic selection of the best whisper model for your CPU.
- Guided Discord bot setup.

### Changed
- Balanced accuracy against latency (greedy decoding, tuned model size) for more
  direct, lower-lag captions.

## [0.1.0] — 2026-06-18

### Added
- Initial release: live stream translation captions for OBS, Streamlabs and any
  browser-source app — captions the streamer's mic and Discord friends,
  translates with Claude, and shows them as a customizable overlay.

[0.3.0]: https://github.com/StreamLex/StreamLex-App/releases/tag/v0.3.0
[0.2.0]: https://github.com/StreamLex/StreamLex-App/releases/tag/v0.2.0
[0.1.0]: https://github.com/StreamLex/StreamLex-App/releases/tag/v0.1.0
