# Release Checklist

## Beta (BRAT) — required before wider distribution

1. Bump `manifest.json` + `package.json` version together; add the new version to
   `versions.json` (`{"<version>": "<minAppVersion>"}`).
2. Push to `dev` — `.github/workflows/release.yml` builds, syncs `main` with the built
   assets (`main.js`, `styles.css`, `manifest.json`, `versions.json`, `package.json`),
   and publishes a tagged GitHub release automatically.
3. Manually verify:
   - [ ] The GitHub Actions run for the push succeeded (Actions tab).
   - [ ] `main` branch contains the updated built assets and the release tag exists.
   - [ ] Fresh vault, install via [BRAT](https://github.com/TfTHacker/obsidian42-brat):
     "Add a beta plugin" → this repo URL → plugin loads, ribbon icons + commands appear,
     no console errors.
   - [ ] Full manual pass of `TESTING.md` scenarios 1–12 with no blocking issues.

## Community plugin list (stretch — not required for beta)

Per the [official submission guide](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin):

- [ ] `manifest.json` has a unique `id`, description ≤250 chars, no "Obsidian"/"plugin" in
  the name.
- [ ] `isDesktopOnly: true` set (confirmed — this plugin depends on Node subprocesses).
- [ ] No bundled API keys/secrets; `npm audit` reviewed for the dependency tree.
- [ ] `README.md` clearly documents what the plugin does and any external
  dependencies (the `pi` CLI) with install instructions.
- [ ] Submit a PR to
  [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) adding
  an entry to `community-plugins.json`.
- [ ] Respond to the automated plugin-review bot's checklist comments.

This is a deliberate stretch goal — BRAT beta distribution is the priority for the
initial release (see `TECHNICAL.md` → Deployment / Release).
