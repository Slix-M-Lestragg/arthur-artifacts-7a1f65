/**
 * Pure, Node-testable protocol logic for the `pi:render-canvas` APC round-trip.
 *
 * Lives in `src/canvas` (plugin source tree) so vitest can exercise it without
 * loading pi-coding-agent. The pi-side extension (`extensions/obsidian-bridge.ts)
 * delegates to this module so the protocol is implemented once and the pi
 * subprocess gets the same behavior.
 *
 * APC framing constants are imported from `src/transport/apc.ts` — the single
 * home for the marker vocabulary (previously redeclared here).
 */

import {
  APC_PREFIX,
  APC_TERM,
  APC_RENDER_CANVAS_PREFIX as RENDER_CANVAS_REQUEST_PREFIX,
  APC_RENDER_CANVAS_RESULT_PREFIX as RENDER_CANVAS_RESULT_PREFIX,
} from '../transport/apc';

const DEFAULT_TIMEOUT_MS = 15000;

interface PendingRender {
  resolve: (png: Buffer) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface RenderCanvasResult {
  requestId: string;
  success: boolean;
  error?: string;
  pngB64?: string;
}

/**
 * Encode a request payload as an APC marker.
 */
export function encodeRenderCanvasRequest(requestId: string, canvasPath: string): string {
  const payload = JSON.stringify({ requestId, canvasPath });
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  return APC_PREFIX + RENDER_CANVAS_REQUEST_PREFIX + b64 + APC_TERM;
}

/**
 * Encode a result payload as an APC marker.
 */
export function encodeRenderCanvasResult(result: RenderCanvasResult): string {
  const payload = JSON.stringify(result);
  const b64 = Buffer.from(payload, 'utf8').toString('base64');
  return APC_PREFIX + RENDER_CANVAS_RESULT_PREFIX + b64 + APC_TERM;
}

/**
 * RPC client used by the pi side. Injected `writeMarker` writes the raw APC
 * marker to stdout (or to the TUI terminal when one is active).
 */
export class RenderCanvasRpc {
  private pending = new Map<string, PendingRender>();
  private nextId = 0;

  constructor(private readonly writeMarker: (marker: string) => void) {}

  /**
   * Send a `pi:render-canvas` request and resolve with the captured PNG bytes
   * when the matching `pi:render-canvas-result` marker arrives. Rejects on error
   * or after the timeout (e.g. standalone pi with no plugin attached).
   */
  requestCapture(
    canvasPath: string,
    opts?: { timeoutMs?: number; requestId?: string },
  ): Promise<Buffer> {
    const requestId = opts?.requestId ?? `rc-${++this.nextId}`;
    const marker = encodeRenderCanvasRequest(requestId, canvasPath);
    this.writeMarker(marker);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Timed out waiting for obsidian canvas capture'));
      }, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, reject, timer });
    });
  }

  /**
   * Handle the base64 payload portion of a `pi:render-canvas-result` marker
   * (everything after `pi:render-canvas-result:`). Returns true if a pending
   * request was resolved/rejected.
   */
  handleResultPayload(payloadB64: string): boolean {
    try {
      const json = Buffer.from(payloadB64, 'base64').toString('utf8');
      const result = JSON.parse(json) as RenderCanvasResult;
      const pending = this.pending.get(result.requestId);
      if (!pending) return false;
      this.pending.delete(result.requestId);
      clearTimeout(pending.timer);
      if (result.success && result.pngB64) {
        pending.resolve(Buffer.from(result.pngB64, 'base64'));
      } else {
        pending.reject(new Error(result.error || 'Canvas capture failed'));
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Number of requests awaiting a result. */
  get pendingCount(): number {
    return this.pending.size;
  }
}
