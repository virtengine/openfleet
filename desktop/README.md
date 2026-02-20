# Bosun Desktop

Bosun Desktop is an Electron shell that launches the Bosun UI server locally
and opens the portal in a native window.

## Development
```bash
cd scripts/bosun/desktop
npm install
npm run start
```

## Launch via Bosun CLI
```bash
cd scripts/bosun
node cli.mjs --desktop
```

## Desktop shortcut
```bash
cd scripts/bosun
node cli.mjs --desktop-shortcut
```

The shortcut launches the desktop portal and will auto-start the bosun daemon
if it is not already running.

## Build installers
```bash
cd scripts/bosun/desktop
npm run dist
```

## Auto-update
- Enable with `BOSUN_DESKTOP_AUTO_UPDATE=1`.
- Optional feed URL override: `BOSUN_DESKTOP_UPDATE_URL=https://.../`.

## Notes
- Packaged apps bundle the Bosun runtime under `resources/bosun/`.
- The UI server runs locally; the desktop app loads `/?token=...` to set the
  session cookie.
