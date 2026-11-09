// Main-process-side registry for the obsidian-pi menu-bar tray.
//
// `Tray` is an Electron MAIN-process object. When Obsidian's renderer reloads
// (dev hot-reload, or Obsidian's "Reload app without saving") the renderer's
// JS heap — including this plugin's MenubarCoordinator/MenubarIcon instances —
// is torn down and recreated, but the main process (and any Tray we created via
// @electron/remote) is untouched. If cleanup didn't run before that reload, the
// old tray is orphaned forever and the next load creates a second icon.
//
// We reach this module from the renderer via `@electron/remote.require(<abs path>)`,
// which returns the MAIN process's cached instance of this module (Node caches
// require() by resolved path, so the same object is returned every time, across
// renderer reloads, until the whole Obsidian process exits). Stashing the active
// tray on it lets a freshly-loaded plugin detect and destroy any tray left
// behind by the previous renderer session before creating a new one.
//
// This module is deliberately CommonJS (not ESM) because the main process here
// is Node/CJS, and it ships as a loose file in the plugin directory (not part
// of the bundled main.js).
'use strict';

/** @type {{ tray: unknown }} */
module.exports = { tray: null };