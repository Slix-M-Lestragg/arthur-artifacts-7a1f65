/**
 * Shared error-formatting helper.
 *
 * Replaces the previously ~60×-inlined `err instanceof Error ? err.message :
 * String(err)` pattern (AUDIT §2 "Error handling"). Use everywhere a thrown
 * value of unknown type is surfaced to a user (Notice, view text, logs).
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}