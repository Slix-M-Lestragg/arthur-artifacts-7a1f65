# Testing

## Pending Validation

## Phase 1: AHP terminal restore on reload

#### 1. Reload restores a single AHP terminal and re-attaches to the live session

**Linked tasks:** ^ahp-terminal-restore-reload

1. Open a remote AHP terminal in Obsidian (ahp:true leaf with an ahpTerminalUri).
2. Reload Obsidian (close and reopen the app).
3. Observe the restored leaf reopens automatically.

*Expected:* The terminal reconnects to the AHP broker, re-subscribes to the saved ahpTerminalUri, and displays the live PTY content (fresh snapshot) without any manual command. No empty-state notice.

- [ ] Completed

---

#### 2. Reload restores multiple AHP terminal leaves, each re-attaches, single client, no duplicate PTY

**Linked tasks:** ^ahp-terminal-restore-reload

1. Open two or more remote AHP terminal leaves (different ahpTerminalUri each).
2. Reload Obsidian.

*Expected:* Each leaf re-attaches to its own channel. Only one shared AhpClient is created. The broker does not spawn duplicate PTYs for the same terminalUri. All leaves show live content.

- [ ] Completed

---

#### 3. Reload with AHP server down or unconfigured shows graceful empty state, no crash

**Linked tasks:** ^ahp-terminal-restore-reload

1. Open a remote AHP terminal, then stop the AHP broker (or clear the server URL in plugin settings).
2. Reload Obsidian.

*Expected:* The restored leaf shows an empty-state panel with a link to open plugin settings (no exception, no spammy errors, no blocking of plugin load). The rest of Obsidian loads normally.

- [ ] Completed

---

#### 4. Saved session URI no longer exists server-side shows notice and retry

**Linked tasks:** ^ahp-terminal-restore-reload

1. Open a remote AHP terminal, then have the broker drop that session (server restart that clears sessions).
2. Reload Obsidian.

*Expected:* The restored leaf shows a "Saved AHP session no longer exists" notice with a Retry button. Clicking retry opens the session picker / new session flow. No crash.

- [ ] Completed

---

#### 5. Vitest suite passes for all restore scenarios

**Linked tasks:** ^ahp-terminal-restore-vitest

1. Run npm test (vitest).

*Expected:* The new ahp-terminal-restore suite passes: single-leaf re-attach, multi-leaf re-attach with shared client, server-down empty-state, missing-session notice, local-instance path unaffected, mobile unaffected. All pre-existing tests still pass.

- [ ] Completed

---

## Phase 1: Farm View client consolidation

#### 6. AhpClient clears stale sessions on reconnect

**Linked tasks:** ^farm-client-clear-reconnect

1. Prime an AhpClient catalogue by calling subscribeRoot with a snapshot/listSessions containing session A.
2. Verify getSessions() returns session A.
3. Simulate a full root reconnect: call subscribeRoot again with a fresh snapshot/listSessions containing only session B.
4. Verify getSessions() returns exactly session B with no leftover session A.

*Expected:* After a full root reconnect, the local sessions cache is rebuilt from the fresh server catalogue and contains no ghost rows from the previous connection.

- [ ] Completed

---

#### 7. FarmView no duplicate rows on host-agent reconnect

**Linked tasks:** ^farm-client-doublerow-guard

1. Open FarmView with a local instance whose id is also present as an external catalogue row.
2. Set the host-agent client to an object whose lastSyncAtMs is undefined and announcedIds is empty (mid-reconnect, first sync pending).
3. Verify no local row is rendered for that instance (temporary suppression prevents a double row).
4. Complete the first sync: set lastSyncAtMs to a timestamp and populate announcedIds with the local instance id, then fire onAnnouncedIdsChanged.
5. Verify the external row remains and the local row is still suppressed (exactly one row).
6. Set hostAgentClient to null and rebuild; verify the local row reappears as the offline fallback.

*Expected:* During host-agent reconnect, local rows are temporarily hidden until the first sync completes, preventing duplicate local + external rows; when the host agent is fully unavailable, local rows still appear.

- [ ] Completed

---

#### 8. FarmView external-session toggle

**Linked tasks:** ^farm-client-external-toggle

1. Open Farm View and verify the External toggle is present in the toolbar and defaults to ON (checked)
2. Confirm hosted sessions, external sessions, and local sessions are all visible with External toggle ON
3. Toggle External OFF and verify external sessions (kind==='external') disappear from the session list
4. Verify hosted (user-created) sessions remain visible after toggling External OFF
5. Verify local/mirror sessions remain visible and unaffected by the External toggle state
6. Toggle External back ON and verify external sessions reappear in the list
7. Reload the vault/pane and verify the External toggle retains its last state (persists across reloads)

*Expected:* External sessions are filtered based on toggle state (ON=visible, OFF=hidden), default is ON, setting persists across reloads, and mirrors/locals remain unaffected.

- [ ] Completed

---

#### 12. Local/relay-backed session opens the local terminal with full TUI resume

**Linked tasks:** ^farm-relay-local-resume

1. Run a local pi session on this device (e.g. named 'NP300-Equipements') so the host-agent mirrors it as a relay row in Farm View.
2. In Farm View, click Open on that relay row.
3. Observe the opened view shows the FULL pi TUI (prior conversation + state, as `pi /resume`), NOT the 'Connected to remote AHP session … Type a message' chat banner.
4. Click Open on a true remote (hosted/external) session row and verify it still opens the remote AHP terminal as before.
5. Verify local-backed rows show a 'local' mirror badge.

*Expected:* local/relay-backed sessions resume the local TUI; true remote sessions unchanged; local-backed rows are badged. The vitest suites `FarmView.test.ts` (5 new) and `InstanceManager.test.ts` (2 new) pass.

- [ ] Completed

---

## Phase 2: Canvas vision rendering

#### 9. SVG renderer renders a canvas to PNG

**Linked tasks:** ^canvas-render-svg-fallback

1. Given a sample .canvas JSON with mixed text/file/link/group nodes and edges using all four sides, call the renderer.
2. Assert the SVG/PNG: node boxes at their absolute x/y/width/height; edges anchor on the correct sides (right/left/top/bottom); color presets 1–6 render with the palette hex; groups render as background containers behind contained nodes; image bounds match the canvas bounding box.

*Expected:* the vitest suite `src/canvas/renderCanvas.test.ts` passes (6 tests) and produces a valid PNG with the PNG signature.

- [ ] Completed

---

#### 10. Obsidian-native capture returns a PNG via APC marker round-trip

**Linked tasks:** ^canvas-render-obsidian-capture

1. With a mocked Electron BrowserWindow whose webContents.capturePage resolves a NativeImage, send a `pi:render-canvas` request marker for a known .canvas path.
2. Assert the handler creates a hidden popout leaf, opens the canvas, awaits render, calls capturePage, returns PNG bytes via a `pi:render-canvas-result` marker.
3. When capturePage rejects, assert it falls back to the lazy SVG renderer (or returns success:false if sharp absent) and still returns a result.

*Expected:* the vitest suites `src/canvas/renderCanvasProtocol.test.ts`, `obsidianCapture.test.ts`, and the PtyClient render-canvas tests pass.

- [ ] Completed

---

#### 11. render_canvas tool returns an image attachment and falls back standalone

**Linked tasks:** ^canvas-render-tool

1. When hosted by the obsidian-pi plugin (OBSIDIAN_PI_HOST=1), calling render_canvas with a .canvas path returns an AgentToolResult whose content contains a `{type:"image",mimeType:"image/png"}` block with non-empty PNG bytes (native capture).
2. When not hosted (standalone), the tool falls back to the SVG renderer and still returns a valid image block (if sharp available) or a clear text error (if not).
3. An invalid/non-existent path returns a text error with no image block.

*Expected:* the vitest suite `src/canvas/renderCanvasTool.test.ts` passes (5 tests).

- [ ] Completed

---
