# App icons (optional, but do this before a real release)

electron-builder looks in this folder (`desktop/build/`) for app icons. Add:

- `icon.ico`  — Windows (multi-size, include 256×256)
- `icon.icns` — macOS
- `icon.png`  — Linux (512×512 or 1024×1024)

Easiest path: make one 1024×1024 PNG, then convert it. The `electron-icon-builder`
tool does all three from a single PNG:

```bash
npx electron-icon-builder --input=logo-1024.png --output=desktop/build
```

If these files are absent, the build still works — it just uses the default
Electron icon. Replace before shipping to users.
