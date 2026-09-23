# FunWithMaps

**Timeline Map** — a small desktop app that plots your Google Maps Timeline export as red dots on your
own map. Runs on macOS, Windows and Linux.

No accounts, no API keys, no telemetry. Your Timeline file is read locally and never
leaves the machine; the only network traffic is basemap tiles from
[OpenFreeMap](https://openfreemap.org).

## Getting your data

Export your Timeline from the Google Maps app:

- **Android:** Settings → Location → Location services → Timeline → *Export Timeline data*
- **iOS:** Google Maps → your profile → Settings → Personal content → *Export Timeline data*

Put the resulting `Timeline.json` **in the folder containing the app** and open the app.
On macOS that means beside `Timeline Map.app`, not inside the bundle; running from source,
it means the repo root. That is the only place the app looks.

You can also drag a file onto the window or use *Open file…*.

## Building

Build on the platform you are targeting:

```
npm run dist:mac     # .dmg + .zip
npm run dist:win     # NSIS installer + portable .exe
npm run dist:linux   # AppImage + .deb
```

Installers land in `dist/`. They are unsigned, so the first launch needs
right-click → **Open** on macOS, and *More info → Run anyway* on Windows.

## Running from source

```
npm install
npm start
```

## Performance notes

A 68 MB / 250k-point export parses in about 200 ms and renders as four GeoJSON sources
on the GPU via MapLibre. Points are sent from the main process to the renderer as raw
`ArrayBuffer`s rather than 250k objects, which keeps the IPC hop effectively free.
