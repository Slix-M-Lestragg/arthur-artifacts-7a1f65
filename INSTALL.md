# Installing arthur into Obsidian

The `main` branch of this repo contains only the files Obsidian needs
(`main.js`, `manifest.json`, `styles.css`, `versions.json`), so installing is a
plain git clone of that branch directly into the vault's plugins directory.

## Install

```sh
git clone -b main <repo-url> <vault>/.obsidian/plugins/arthur
```

Then in Obsidian: **Settings → Community plugins → Installed plugins** and
enable **Arthur**.

## Updating

The plugin performs no update checks itself (LAN-only tool). To update:

```sh
cd <vault>/.obsidian/plugins/arthur
git pull
```

...then reload Obsidian (or toggle the plugin off/on).
