# arthur

A desktop-only Obsidian plugin for remotely managing AI workloads on a LAN home
server: monitor ComfyUI generation (queue, progress, VRAM) and ai-toolkit
training (steps, loss, GPU usage), control jobs, and start/stop/restart ComfyUI
instances via a tiny companion agent on the server.

Pure HTTP/WS client — the plugin never runs anything locally beyond itself.

## Branch layout

- **`dev`** (default branch) — all source, tests, and docs. See
  [docs/PLAN.md](docs/PLAN.md) for the full project plan.
- **`main`** — compiled artifacts only (`main.js`, `manifest.json`,
  `styles.css`, `versions.json`, `INSTALL.md`). Nothing else. This is the
  branch that gets installed into Obsidian.

## Development

```sh
npm install
npm run typecheck   # tsc --noEmit
npm run dev         # esbuild watch -> build/main.js (gitignored)
npm run build       # typecheck + production build -> main.js at repo root
npm run release     # build production + assemble artifacts-only commit onto main
```

Releases go `dev` → `main` exclusively through `scripts/release.mjs`, which
copy only the plugin artifact set onto `main` and never merge dev's other
files.
