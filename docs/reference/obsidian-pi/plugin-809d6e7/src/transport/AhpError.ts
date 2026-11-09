/**
 * Structured JSON-RPC error surfaced by AhpClient / HostAgentClient request
 * rejections. Preserves the wire `code` and `data` payload so callers can
 * branch on code EQUALITY instead of regex-sniffing the formatted message
 * (audit 2026-09-01, remediation item 3 / §1.1 finding 5 — mirrors the
 * proven `AHPError` in the pi-ahp-client extension's ahp-client.ts).
 *
 * `.message` still embeds the code (`"${message} (code ${code})"`) so
 * existing Notice text built from `err.message` stays readable.
 */
export class AhpError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(`${message} (code ${code})`);
    this.name = 'AhpError';
  }
}

/** Type guard: true when `err` is an AhpError carrying a JSON-RPC code. */
export function isAhpError(err: unknown, code?: number): err is AhpError {
  return err instanceof AhpError && (code === undefined || err.code === code);
}