/**
 * obsidian-bridge.ts — pi extension shipped inside the obsidian-pi plugin.
 *
 * Loaded by the plugin's PtyClient via `pi -e <plugin>/extensions/obsidian-bridge.ts`.
 * pi's jiti loader applies aliases so `@earendil-works/*` imports resolve to pi's
 * own bundled copies regardless of this file's location.
 *
 * Installs a custom editor component (ObsidianBridgeEditor) that:
 *   • Keeps the in-terminal editor FULLY interactive — every normal keystroke is
 *     forwarded to the default editor, so /tree, /model, /settings, overlays,
 *     autocomplete, history and direct typing all work exactly as in a real
 *     terminal. (Decision: terminal stays an interactive surface.)
 *   • Recognizes a custom APC submit marker written to the PTY by the Obsidian
 *     floating prompt popout:
 *         ESC _ pi:prompt:<base64(text)> ESC \        (ST-terminated APC)
 *     When the marker arrives, it sets the editor text and triggers pi's normal
 *     submit path (Enter), so history / steering / follow-up behave exactly as
 *     if the user had typed the text and pressed Enter.
 *   • Forwards agent lifecycle events (agent_start/agent_end and question_user)
 *     to the plugin as `ESC _ pi:notify:<base64(JSON)> ESC \` APC markers,
 *     so Obsidian can surface OS/in-app notifications even though the TUI is
 *     running inside a PTY subprocess.
 *   • Recognizes a reverse-direction get-text request from the Obsidian prompt
 *     editor's "Pull from TUI" button:
 *         ESC _ pi:get-text ESC \                      (request, no payload)
 *     The editor replies on stdout with the current (paste-marker-expanded)
 *     text so it can be pulled into the floating/docked prompt composer:
 *         ESC _ pi:text:<base64(text)> ESC \          (response)
 *     The PtyClient intercepts the response marker in its data stream (before
 *     xterm) and resolves the requestEditorText() promise.
 *
 * APC pass-through is confirmed against pi-tui internals:
 *   • StdinBuffer.isCompleteApcSequence() treats `ESC _ … ESC \` as one complete
 *     APC sequence (it requires the ST terminator `ESC \`, NOT BEL).
 *   • ProcessTerminal.forwardInputSequence() forwards it unchanged to onInput.
 *   • TUI.handleInput() does not consume APC (only OSC 11 / DSR / cell-size /
 *     Kitty-negotiation responses are intercepted) and passes it to the focused
 *     component's handleInput() in a single call.
 */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type AgentEndEvent,
  type AgentStartEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionEndEvent,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type TUI,
  type EditorTheme,
  type KeybindingsManager,
  type Component,
} from "@earendil-works/pi-tui";
import * as path from "node:path";

const ESC = "\x1b";
const APC_PREFIX = ESC + "_"; // ESC _   (start of APC)
const APC_TERM = ESC + "\\"; // ESC \   (ST — APC terminator, per pi-tui stdin buffer)
const PAYLOAD_PREFIX = "pi:prompt:";
// Reverse-direction protocol (see PtyClient.requestEditorText):
//   request:  ESC _ pi:get-text ESC \         (sent by the plugin, no payload)
//   response: ESC _ pi:text:<base64> ESC \    (written here to stdout)
const GETTEXT_RESPONSE_PREFIX = "pi:text:";
// Agent lifecycle notification marker (Phase 12):
//   ESC _ pi:notify:<base64(JSON)> ESC \
const NOTIFY_PREFIX = "pi:notify:";
// Answer marker written BY the Obsidian plugin back to the PTY stdin so this
// extension can resolve an in-flight question_user panel from a notification
// reply (terminal mode):
//   ESC _ pi:answer:<questionId>:<base64(JSON {answer,wasCustom})> ESC \
const APC_ANSWER_PREFIX = "pi:answer:";

// Home key → tui.editor.cursorLineStart → moves cursor to column 0.
// We move to col 0 before submitting so pi's "trailing backslash" Enter
// workaround (which would insert a newline instead of submitting when the
// char before the cursor is `\`) is bypassed.
const HOME_SEQ = ESC + "[H";
const ENTER_SEQ = "\r";

/** Tool names that represent "waiting for user input". */
const QUESTION_TOOL_NAMES = new Set([
  "question_user",
  "question-user",
  "ask_user",
  "ask_user_question",
]);

/** Payload shape matching the plugin's AgentEvent interface. */
type AgentEventType =
  | "start"
  | "end"
  | "error"
  | "abort"
  | "question"
  | "session_start";

interface AgentEventPayload {
  instanceId: string;
  cwd: string;
  type: AgentEventType;
  model?: string;
  turns?: number;
  tokens?: number;
  cost?: number;
  message?: string;
  /** Present when type === "session_start". */
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
  /** Absolute path to the active session file, present when type === "session_start". */
  sessionFile?: string;
  /** Correlates a "question" event with the in-flight question_user tool call. */
  questionId?: string;
  /** Selectable option labels for a "question" event. */
  options?: string[];
  /** Whether freeform text answers are accepted for a "question" event. */
  allowFreeform?: boolean;
  /** Current thinking level, sent as a live snapshot on every lifecycle event. */
  thinkingLevel?: string;
  /** Current context window usage in tokens, or null when unknown (e.g. right after compaction). */
  contextTokens?: number | null;
  /** The active model's context window size, in tokens. */
  contextWindow?: number;
  /** Context usage as a percentage of contextWindow, or null when unknown. */
  contextPercent?: number | null;
}

/** Reference to the active TUI terminal for writing APC markers. */
let activeTui: TUI | null = null;

/**
 * Live, always-current fields to spread into every notify event regardless of
 * type: current model, thinking level, and context-window usage. Failures are
 * swallowed — these are best-effort tooltip stats, never worth crashing the
 * bridge over.
 */
function liveExtras(pi: ExtensionAPI, ctx: ExtensionContext): Partial<AgentEventPayload> {
  let thinkingLevel: string | undefined;
  try {
    thinkingLevel = pi.getThinkingLevel?.() as unknown as string | undefined;
  } catch { /* best-effort */ }

  let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  try {
    usage = ctx.getContextUsage?.();
  } catch { /* best-effort */ }

  return {
    model: ctx.model?.id,
    thinkingLevel,
    contextTokens: usage ? usage.tokens : undefined,
    contextWindow: usage?.contextWindow,
    contextPercent: usage ? usage.percent : undefined,
  };
}

/**
 * questionId of the most recently started question_user tool call, stashed by
 * the tool_execution_start handler so the ctx.ui.custom wrapper (invoked next
 * by the tool's execute()) can correlate the panel's `done` resolver with the
 * notify event already sent to the plugin. Cleared once consumed.
 */
let pendingQuestionId: string | null = null;

/**
 * Map of questionId > the question_user panel's `done` resolver, captured by
 * wrapping ctx.ui.custom. A `pi:answer:` APC marker from the plugin invokes
 * the matching resolver (and clears the entry) so a notification reply feeds
 * the answer straight back to the tool without a terminal round-trip.
 */
const pendingAnswers = new Map<string, (result: unknown) => void>();

/** Normalize a question_user option (string | {label, description?}) to its label. */
function normalizeOptionLabel(o: unknown): string {
  if (typeof o === "string") return o;
  if (o && typeof o === "object" && "label" in o) {
    return String((o as { label: unknown }).label ?? "?");
  }
  return String(o ?? "?");
}

/** Unwrap pi's option-serialisation quirks. pi sometimes passes `options` as a
 * JSON-stringified array string (Anthropic path) or as a single-element array
 * wrapping that string; both must be parsed to a plain array. Mirrors
 * question-user.ts's unwrapOptions(). */
function unwrapOptions(raw: unknown): unknown[] {
  if (Array.isArray(raw)) {
    if (raw.length === 1 && typeof raw[0] === "string") {
      try {
        return JSON.parse(raw[0] as string);
      } catch {
        return raw;
      }
    }
    return raw;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Thin proxy around a question_user panel component: forwards render/
 * invalidate/dispose and all keyboard input unchanged, but intercepts a
 * `pi:answer:<questionId>:` APC marker (written to PTY stdin by the Obsidian
 * plugin when a notification is answered) and resolves the panel via the
 * stashed `done` resolver instead of forwarding it to the real panel.
 */
function makeAnswerProxy(real: Component & { dispose?(): void }, questionId: string): Component & { dispose?(): void } {
  const proxy: Component & { dispose?(): void; handleInput(data: string): void } = {
    render: (w: number) => real.render(w),
    invalidate: () => real.invalidate(),
    dispose: () => real.dispose?.(),
    handleInput: (data: string) => {
      if (
        data.length >= APC_PREFIX.length + APC_ANSWER_PREFIX.length + APC_TERM.length &&
        data.startsWith(APC_PREFIX) &&
        data.endsWith(APC_TERM)
      ) {
        const payload = data.slice(APC_PREFIX.length, data.length - APC_TERM.length);
        if (payload.startsWith(APC_ANSWER_PREFIX)) {
          const rest = payload.slice(APC_ANSWER_PREFIX.length);
          const colon = rest.indexOf(":");
          if (colon > 0 && rest.slice(0, colon) === questionId) {
            const b64 = rest.slice(colon + 1);
            try {
              const result = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
              const done = pendingAnswers.get(questionId);
              if (done) {
                pendingAnswers.delete(questionId);
                done(result);
                return; // consume — don't forward to the panel
              }
            } catch { /* malformed — fall through to real panel */ }
          }
        }
      }
      real.handleInput?.(data);
    },
  };
  if (real.wantsKeyRelease !== undefined) {
    (proxy as Component).wantsKeyRelease = real.wantsKeyRelease;
  }
  return proxy;
}

/** Write an agent-lifecycle event to stdout as a pi:notify APC marker. */
function writeNotifyEvent(event: AgentEventPayload): void {
  const json = JSON.stringify(event);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  const marker = APC_PREFIX + NOTIFY_PREFIX + b64 + APC_TERM;
  if (activeTui?.terminal) {
    activeTui.terminal.write(marker);
  } else {
    process.stdout.write(marker);
  }
}

// ── Canvas native-capture RPC protocol ─────────────────────────────────────
//
// Inlined from src/canvas/renderCanvasProtocol.ts so the bridge is self-contained
// in the plugin-release distribution (which has no ../src/ tree). The plugin
// side keeps an identical copy bundled into main.js; the two sides agree on the
// wire marker strings by convention.

const RENDER_CANVAS_REQUEST_PREFIX = "pi:render-canvas:";
const RENDER_CANVAS_RESULT_PREFIX = "pi:render-canvas-result:";
const DEFAULT_TIMEOUT_MS = 15000;

interface PendingRender {
  resolve: (png: Buffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface RenderCanvasResult {
  requestId: string;
  success: boolean;
  error?: string;
  pngB64?: string;
}

function encodeRenderCanvasRequest(requestId: string, canvasPath: string): string {
  const payload = JSON.stringify({ requestId, canvasPath });
  const b64 = Buffer.from(payload, "utf8").toString("base64");
  return APC_PREFIX + RENDER_CANVAS_REQUEST_PREFIX + b64 + APC_TERM;
}

class RenderCanvasRpc {
  private pending = new Map<string, PendingRender>();
  private nextId = 0;

  constructor(private readonly writeMarker: (marker: string) => void) {}

  requestCapture(canvasPath: string, opts?: { timeoutMs?: number; requestId?: string }): Promise<Buffer> {
    const requestId = opts?.requestId ?? `rc-${++this.nextId}`;
    const marker = encodeRenderCanvasRequest(requestId, canvasPath);
    this.writeMarker(marker);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Timed out waiting for obsidian canvas capture"));
      }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  handleResultPayload(payloadB64: string): boolean {
    try {
      const json = Buffer.from(payloadB64, "base64").toString("utf8");
      const result = JSON.parse(json) as RenderCanvasResult;
      const pending = this.pending.get(result.requestId);
      if (!pending) return false;
      this.pending.delete(result.requestId);
      clearTimeout(pending.timer);
      if (result.success && result.pngB64) {
        pending.resolve(Buffer.from(result.pngB64, "base64"));
      } else {
        pending.reject(new Error(result.error || "Canvas capture failed"));
      }
      return true;
    } catch {
      return false;
    }
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

/** Shared RPC client for canvas native-capture requests (Milestone 2). */
const renderCanvasRpc = new RenderCanvasRpc((marker: string) => {
  if (activeTui?.terminal) {
    activeTui.terminal.write(marker);
  } else {
    process.stdout.write(marker);
  }
});

/**
 * Request an Obsidian-native canvas capture from the plugin side.
 *
 * Writes a `pi:render-canvas` APC marker to stdout and returns a promise that
 * resolves with the PNG bytes when the matching `pi:render-canvas-result`
 * marker arrives. Rejects if the plugin reports an error or if the timeout
 * expires (e.g. standalone pi with no Obsidian plugin attached).
 *
 * This is the pi-side RPC entry point milestone 3 will call.
 */
export const requestObsidianCanvasCapture = renderCanvasRpc.requestCapture.bind(renderCanvasRpc);

// ── Canvas vision tool (Milestone 3) ─────────────────────────────────────
//
// Inlined from src/canvas/renderCanvasTool.ts. The tool is registered with the
// pi ExtensionAPI directly inside this file so the bridge does not depend on
// the src/ tree at load time. The SVG fallback is a LAZY dynamic import that
// only runs when native capture is skipped/fails, so missing sharp/node_modules
// in the plugin-release distribution does not prevent the bridge from loading.

interface ToolContentText {
  type: "text";
  text: string;
}

interface ToolContentImage {
  type: "image";
  data: Uint8Array | Buffer;
  mimeType: "image/png";
}

type ToolContent = ToolContentText | ToolContentImage;

interface SvgCaptureResult {
  png: Buffer;
  width?: number | null;
  height?: number | null;
}

interface RenderCanvasToolResult {
  content: ToolContent[];
  details: {
    path: string;
    method?: "native" | "svg";
    width?: number | null;
    height?: number | null;
    error?: string;
  };
}

/** Best-effort parse width/height from a PNG buffer's IHDR chunk. */
function parsePngDimensions(buffer: Buffer): { width: number; height: number } | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47 ||
      buffer[4] !== 0x0d || buffer[5] !== 0x0a || buffer[6] !== 0x1a || buffer[7] !== 0x0a) {
    return null;
  }
  // IHDR is always the first chunk, starting at offset 8 (length) + 12 (chunk type).
  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType !== "IHDR") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

/** Core render_canvas logic: native-first, SVG fallback. */
async function executeRenderCanvas(options: {
  path: string;
  cwd?: string;
  hostEnabled: boolean;
  nativeCapture: (canvasPath: string, opts?: { timeoutMs?: number }) => Promise<Buffer>;
  svgCapture: (canvasPath: string) => Promise<SvgCaptureResult>;
}): Promise<RenderCanvasToolResult> {
  const { path: inputPath, cwd, hostEnabled, nativeCapture, svgCapture } = options;
  const resolvedPath = path.resolve(cwd ?? process.cwd(), inputPath);

  let lastError: Error | undefined;

  if (hostEnabled) {
    try {
      const png = await nativeCapture(resolvedPath, { timeoutMs: 12_000 });
      const dims = parsePngDimensions(png);
      const width = dims?.width ?? null;
      const height = dims?.height ?? null;
      const dimText = width != null && height != null ? `to a ${width}x${height} PNG` : "to a PNG";
      return {
        content: [
          { type: "text", text: `Rendered canvas '${inputPath}' ${dimText} via native.` },
          { type: "image", data: png, mimeType: "image/png" },
        ],
        details: { path: inputPath, method: "native", width, height },
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Fall through to SVG capture.
    }
  }

  try {
    const { png, width, height } = await svgCapture(resolvedPath);
    const w = width ?? null;
    const h = height ?? null;
    const dimText = w != null && h != null ? `to a ${w}x${h} PNG` : "to a PNG";
    return {
      content: [
        { type: "text", text: `Rendered canvas '${inputPath}' ${dimText} via svg.` },
        { type: "image", data: png, mimeType: "image/png" },
      ],
      details: { path: inputPath, method: "svg", width: w, height: h },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const message = lastError
      ? `${error.message} (native attempt: ${lastError.message})`
      : error.message;
    return {
      content: [{ type: "text", text: `Could not render canvas '${inputPath}': ${message}` }],
      details: { path: inputPath, error: message },
    };
  }
}

/**
 * Lazy SVG fallback capture. Only executed if native capture is unavailable.
 * In the full dev repo this dynamically imports the sharp-based renderer from
 * src/canvas/renderCanvas. In the plugin-release distribution (no src/ tree,
 * no sharp/node_modules) it throws a descriptive error and the tool returns a
 * text-only failure instead of an image.
 */
const lazySvgCapture = async (canvasPath: string): Promise<SvgCaptureResult> => {
  try {
    const { renderCanvasToPng } = await import("../src/canvas/renderCanvas");
    const r = await renderCanvasToPng(canvasPath);
    return { png: r.png, width: r.width ?? null, height: r.height ?? null };
  } catch (e) {
    throw new Error(`SVG fallback unavailable in this build (needs sharp + src/): ${e instanceof Error ? e.message : String(e)}`);
  }
};

/**
 * Minimal JSON Schema factory for the render_canvas tool parameter schema.
 * Used instead of importing `Type` from `typebox` so the bridge has no bare
 * package dependency at load time; pi's runtime accepts plain JSON Schema for
 * custom tool parameters.
 */
const renderCanvasSchema = {
  type: "object" as const,
  required: ["path"],
  properties: {
    path: {
      type: "string" as const,
      description: "Vault-relative path to the .canvas file (e.g. 'Boards/My.canvas')",
    },
  },
};

class ObsidianBridgeEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings);
    activeTui = tui;
  }

  handleInput(data: string): void {
    // APC submit marker: ESC _ pi:prompt:<base64> ESC \
    if (
      data.length >= APC_PREFIX.length + PAYLOAD_PREFIX.length + APC_TERM.length &&
      data.startsWith(APC_PREFIX) &&
      data.endsWith(APC_TERM)
    ) {
      const payload = data.slice(
        APC_PREFIX.length,
        data.length - APC_TERM.length,
      );
      if (payload.startsWith(PAYLOAD_PREFIX)) {
        const b64 = payload.slice(PAYLOAD_PREFIX.length);
        try {
          const text = Buffer.from(b64, "base64").toString("utf8");
          // Set the text, move to col 0, then submit via Enter so the real
          // onSubmit path runs (history / steering / follow-up preserved).
          this.setText(text);
          super.handleInput(HOME_SEQ); // cursor → col 0
          super.handleInput(ENTER_SEQ); // submit
          return;
        } catch {
          // Decode failure — fall through to default handling.
        }
      }

      // APC get-text request: ESC _ pi:get-text ESC \
      // Reply with the current editor text (paste-marker-expanded) so the
      // Obsidian prompt editor can pull in what the user typed in the TUI.
      // Written to stdout via this.tui.terminal.write(); the PtyClient
      // intercepts the response APC marker in its data stream.
      if (payload === "pi:get-text") {
        try {
          const text =
            typeof this.getExpandedText === "function"
              ? this.getExpandedText()
              : this.getText();
          const b64 = Buffer.from(text, "utf8").toString("base64");
          this.tui.terminal.write(
            APC_PREFIX + GETTEXT_RESPONSE_PREFIX + b64 + APC_TERM,
          );
        } catch {
          // Respond with empty text so the plugin's promise resolves rather
          // than timing out.
          this.tui.terminal.write(
            APC_PREFIX + GETTEXT_RESPONSE_PREFIX + APC_TERM,
          );
        }
        return;
      }

      // APC clear-text request: empty the editor without submitting.
      if (payload === "pi:clear-text") {
        this.setText("");
        super.handleInput(HOME_SEQ);
        return;
      }

      // APC render-canvas result: resolve an in-flight canvas capture request.
      if (payload.startsWith("pi:render-canvas-result:")) {
        const b64 = payload.slice("pi:render-canvas-result:".length);
        renderCanvasRpc.handleResultPayload(b64);
        return;
      }
    }
    // Default: keep the terminal editor fully interactive.
    super.handleInput(data);
  }

  render(width: number): string[] {
    const lines = super.render(width);
    // When the editor is empty, show a dim hint on the bottom border so users
    // discover the richer floating composer in the Obsidian popout window.
    const text = this.getText();
    if (text.trim().length === 0 && lines.length > 0) {
      const label = " ✍️ compose in floating window (⌘E) ";
      const last = lines.length - 1;
      const labelWidth = visibleWidth(label);
      if (width - visibleWidth(lines[last]!) >= labelWidth) {
        lines[last] =
          truncateToWidth(lines[last]!, width - labelWidth, "") +
          ESC + "[2m" + label + ESC + "[0m";
      }
    }
    return lines;
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (event: { reason?: string }, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new ObsidianBridgeEditor(tui, theme, keybindings),
    );

    // Wrap ctx.ui.custom so that when question_user renders its TUI panel we
    // can capture the panel's `done` resolver (keyed by the questionId stashed
    // at tool_execution_start). A `pi:answer:` APC marker from the plugin then
    // resolves the panel from a notification reply (see makeAnswerProxy).
    const origCustom = ctx.ui.custom.bind(ctx.ui);
    (ctx.ui as { custom: unknown }).custom = (
      factory: (tui: TUI, theme: EditorTheme, kb: KeybindingsManager, done: (result: unknown) => void) => Component & { dispose?(): void },
      options?: { overlay?: boolean },
    ) => {
      const qid = pendingQuestionId;
      if (qid) {
        pendingQuestionId = null;
        const wrappedFactory = (
          tui: TUI,
          theme: EditorTheme,
          kb: KeybindingsManager,
          done: (result: unknown) => void,
        ) => {
          const wrappedDone = (result: unknown) => {
            pendingAnswers.delete(qid);
            done(result);
          };
          const real = factory(tui, theme, kb, wrappedDone);
          pendingAnswers.set(qid, wrappedDone);
          return makeAnswerProxy(real, qid);
        };
        return origCustom(wrappedFactory as typeof factory, options);
      }
      return origCustom(factory, options);
    };

    // Notify the plugin of the authoritative new session path. Skip the very
    // first process startup: activeTui is not yet assigned (the editor factory
    // above is registered but not instantiated until the TUI needs it), so the
    // marker would be written to stdout. The plugin already supplies that path
    // via --session, making this emit a no-op for startup.
    if (event.reason === "startup") return;

    const sessionFile = (ctx as any).sessionManager?.getSessionFile?.();
    if (sessionFile) {
      writeNotifyEvent({
        type: "session_start",
        reason: event.reason as any,
        sessionFile,
        instanceId: "",
        cwd: "",
      });
    }
  });

  // ── Agent lifecycle notifications (Phase 12) ──────────────────────────────

  pi.on("agent_start", (_event: AgentStartEvent, ctx) => {
    writeNotifyEvent({ instanceId: "", cwd: "", type: "start", ...liveExtras(pi, ctx) });
  });

  pi.on("agent_end", (event: AgentEndEvent, ctx) => {
    const lastAssistant = [...event.messages]
      .reverse()
      .find((m: any) => m.role === "assistant") as any;
    const stopReason: string = lastAssistant?.stopReason ?? "stop";
    const isAborted = stopReason === "aborted";
    const isError = stopReason === "error";

    const usage = event.messages
      .filter((m: any) => m.role === "assistant" && m.usage)
      .reduce(
        (acc: any, m: any) => ({
          input: acc.input + (m.usage?.input ?? 0),
          output: acc.output + (m.usage?.output ?? 0),
          cost: acc.cost + (m.usage?.cost?.total ?? 0),
        }),
        { input: 0, output: 0, cost: 0 },
      );

    const extras = liveExtras(pi, ctx);
    const model = extras.model ?? "unknown";
    const turns = event.messages.filter((m: any) => m.role === "assistant").length;

    if (isAborted) {
      writeNotifyEvent({ instanceId: "", cwd: "", type: "abort", ...extras });
    } else if (isError) {
      const message = lastAssistant?.errorMessage ?? "unknown error";
      writeNotifyEvent({
        instanceId: "",
        cwd: "",
        type: "error",
        turns,
        message,
        ...extras,
        model,
      });
    } else {
      writeNotifyEvent({
        instanceId: "",
        cwd: "",
        type: "end",
        turns,
        tokens: usage.output > 0 ? usage.output : undefined,
        cost: usage.cost > 0 ? usage.cost : undefined,
        ...extras,
        model,
      });
    }
  });

  pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx) => {
    if (!QUESTION_TOOL_NAMES.has(event.toolName)) return;

    const args = (event.args ?? {}) as {
      question?: string;
      context?: string;
      options?: unknown;
      allowFreeform?: boolean;
    };
    const labels = unwrapOptions(args.options).map(normalizeOptionLabel);
    const allowFreeform = args.allowFreeform !== false;
    const message = [args.context, args.question].filter(Boolean).join("\n\n") || args.question || "";

    // Stash for the ctx.ui.custom wrapper (invoked next by execute()).
    pendingQuestionId = event.toolCallId;

    writeNotifyEvent({
      instanceId: "",
      cwd: "",
      type: "question",
      questionId: event.toolCallId,
      message,
      options: labels,
      allowFreeform,
      ...liveExtras(pi, ctx),
    });
  });

  pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx) => {
    // Defensive: clear any un-consumed pendingQuestionId (e.g. the tool
    // returned early without rendering a panel) so a later, unrelated
    // ctx.ui.custom call isn't erroneously intercepted.
    pendingQuestionId = null;

    // The question_user tool call just resolved (answer received, whether via
    // the TUI panel or a notification reply) and the agent immediately resumes
    // inference within the SAME turn — there's no natural "resumed" event for
    // this (agent_start/agent_end only bracket whole turns). Emit one anyway,
    // reusing the 'start' type purely so the terminal tab icon flips back to
    // 'running' right away instead of staying on the "?" until the eventual
    // agent_end. AgentNotifier explicitly ignores 'start' for notifications,
    // so this can't cause a spurious popup.
    if (QUESTION_TOOL_NAMES.has(event.toolName)) {
      writeNotifyEvent({ instanceId: "", cwd: "", type: "start", ...liveExtras(pi, ctx) });
    }
  });

  // ── Canvas vision tool registration ───────────────────────────────────────

  pi.registerTool({
    name: "render_canvas",
    label: "Render Canvas",
    description:
      "Render an Obsidian .canvas file to a PNG image and return it as an attachment, so you can visually analyze node placement, connections, and layout. Pairs with a vision-capable model (e.g. ollama-cloud/glm-5.3-flash).",
    promptSnippet: "Render a .canvas file to an image for visual analysis",
    promptGuidelines: [
      "Use this tool when you need to SEE an Obsidian canvas's spatial layout (node positions, edges, groupings) rather than just reading the .canvas JSON.",
      "After rendering, analyze the returned image visually — describe placement, clusters, connector flow, and any layout issues. Use a vision-capable model (e.g. ollama-cloud/glm-5.3-flash) for the analysis.",
    ],
    parameters: renderCanvasSchema as unknown as Record<string, unknown>,
    async execute(_toolCallId: string, params: { path: string }, _signal: unknown, _onUpdate: unknown, ctx?: { cwd?: string }) {
      return executeRenderCanvas({
        path: params.path,
        cwd: ctx?.cwd,
        hostEnabled: !!process.env.OBSIDIAN_PI_HOST,
        nativeCapture: requestObsidianCanvasCapture,
        svgCapture: lazySvgCapture,
      });
    },
  });
}
