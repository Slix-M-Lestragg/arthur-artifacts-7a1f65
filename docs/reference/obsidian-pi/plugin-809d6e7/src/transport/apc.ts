/**
 * APC (Application Program Command) marker constants shared between the
 * local PTY client and the remote AHP terminal adapter.
 *
 * These are plain string literals with **no Node dependencies**, isolated in
 * their own module so that importing them does not pull `PtyClient` (and its
 * top-level `require('fs'|'path')`) into the mobile load path.  See
 * `AhpTerminalAdapter.ts` — the only thing it needs from the PTY world is these
 * four constants, so it imports them from here, not from `PtyClient.ts`.
 */

// APC submit marker format (must match the bridge extension parser):
//   ESC _ pi:prompt:<base64(text)> ESC \     (ST-terminated APC)
export const APC_PREFIX   = '\x1b_';        // ESC _
export const APC_TERM     = '\x1b\\';       // ESC \  (ST — required by pi-tui stdin buffer)
export const APC_PAYLOAD  = 'pi:prompt:';

// Agent answer marker written BY the plugin back to the PTY stdin so the
// obsidian-bridge proxy can resolve an in-flight question_user panel from a
// notification reply (terminal mode):
//   ESC _ pi:answer:<questionId>:<base64(JSON {answer,wasCustom})> ESC \
export const APC_ANSWER_PREFIX = 'pi:answer:';

// Canvas native-capture request from the pi side and the plugin's result:
//   request: ESC _ pi:render-canvas:<base64(JSON {requestId, canvasPath})> ESC \
//   result:  ESC _ pi:render-canvas-result:<base64(JSON {requestId, success, error?, pngB64?})> ESC \
export const APC_RENDER_CANVAS_PREFIX = 'pi:render-canvas:';
export const APC_RENDER_CANVAS_RESULT_PREFIX = 'pi:render-canvas-result:';