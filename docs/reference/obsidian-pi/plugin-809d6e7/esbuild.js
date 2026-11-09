const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const prod = process.argv[2] === 'production';

// Both dev and prod output to this directory — it IS the Obsidian plugin folder.
const outfile = path.join(__dirname, 'main.js');

// Ensure .hotreload exists so the hot-reload community plugin picks up rebuilds.
if (!prod) {
  const hotreloadPath = path.join(__dirname, '.hotreload');
  if (!fs.existsSync(hotreloadPath)) fs.writeFileSync(hotreloadPath, '');
}

// All Node built-ins must stay external (Electron renderer has full Node access).
const nodeBuiltins = require('module').builtinModules;

const config = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian',
    'electron',
    '@electron/remote',
    'node-pty',
    'sharp',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
    ...nodeBuiltins,
    ...nodeBuiltins.map((m) => `node:${m}`),
  ],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile,
  platform: 'node',
  // Import xterm.js CSS as a string (injected at runtime) rather than emitting a CSS file.
  loader: { '.css': 'text' },
};

(async () => {
  if (prod) {
    await esbuild.build(config);
    console.log('Build complete →', outfile);
    process.exit(0);
  } else {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log('Watching → ' + outfile);
  }
})();
