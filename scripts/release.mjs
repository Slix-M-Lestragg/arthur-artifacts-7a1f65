#!/usr/bin/env node
// scripts/release.mjs — assemble a release commit onto the `main` branch.
//
// `main` is an ARTIFACTS-ONLY branch: main.js, manifest.json, styles.css,
// versions.json, INSTALL.md — nothing else must ever land there. This script:
//   1. requires a clean `dev` tree (everything from dev is committed) and
//      reads the version from dev's manifest.json
//   2. runs the production esbuild (main.js at repo root, gitignored on dev)
//   3. checks out `main` (creating it as an orphan branch on first run)
//   4. stages ONLY the artifact files (git add -f, since main.js is
//      gitignored so dev worktrees never track a stray bundle) and commits
//   5. returns to `dev`: the dev files left in the worktree are untracked
//      duplicates (git refuses to switch over them), so they are cleaned
//      first — safe by construction because dev was clean in step 1.
//
// Run from the repo root on a clean dev tree: `npm run release`.

import { execSync } from "node:child_process";
import fs from "node:fs";

const ARTEFACTS = [
	"main.js",
	"manifest.json",
	"styles.css",
	"versions.json",
	"INSTALL.md",
];

const run = (cmd) => execSync(cmd, { stdio: "inherit" });
const runOut = (cmd) => execSync(cmd, { encoding: "utf8" });

// 1. Must run on dev with a clean tree — see step 5 for why this matters.
const branch = runOut("git branch --show-current").trim();
if (branch !== "dev") throw new Error(`Run this on dev (currently on '${branch}')`);
if (runOut("git status --porcelain").trim())
	throw new Error("dev tree is dirty; commit or stash before releasing");

// Version from the dev manifest (read before switching branches).
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
if (!manifest.version) throw new Error("manifest.json has no version");

// 2. Production build -> main.js at repo root.
run("node esbuild.config.mjs production");
if (!fs.existsSync("main.js")) throw new Error("production build produced no main.js");

// Snapshot the artifact contents, then remove main.js from the worktree so
// `git checkout main` never clashes with the untracked bundle.
const snapshot = Object.fromEntries(ARTEFACTS.map((f) => [f, fs.readFileSync(f)]));
fs.rmSync("main.js", { force: true });

// 3. Switch to main (orphan-create it on the first release).
const mainExists =
	runOut("git rev-parse --verify main || true").trim().length > 0;
if (mainExists) {
	run("git checkout main");
} else {
	run("git checkout --orphan main");
	// Unstage everything inherited from dev; only artifacts get committed.
	run("git rm -rf --cached .");
}

// 4. Write the artifact set and stage it (-f: main.js is in .gitignore).
for (const f of ARTEFACTS) fs.writeFileSync(f, snapshot[f]);
run(`git add -f -- ${ARTEFACTS.join(" ")}`);

if (runOut("git diff --cached --name-only").trim()) {
	run(`git commit -m "Release v${manifest.version}"`);
	console.log(`Committed release v${manifest.version} onto main.`);
} else {
	console.log("No artifact changes since last release; nothing to commit.");
}

// 5. Return to dev. The non-artifact dev files are untracked duplicates here
// (git refuses to switch branches over identical-but-untracked files), so
// clean them first — dev was guaranteed clean in step 1, and `git clean -fd`
// without -x leaves gitignored entries (node_modules/, build/) untouched.
run("git clean -fd");
run("git checkout dev");
