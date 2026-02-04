# Offload Disk Client

Windows-first desktop client for Offload Disk (Tauri + React).

## Dev

```sh
npm install
npm run dev
```

In another terminal:
```sh
npm run tauri dev
```

## Build

```sh
npm run build
npm run tauri build
```

## Notes
- Auto-updates use GitHub Releases. Update `src-tauri/tauri.conf.json` with your release feed.
- Download manager uses a `.part` temp file and emits `download-progress` events.