/**
 * Shared audio-capture capability check for the voice-dictation feature
 * (see stt-stream.ts for the streaming client).
 *
 * ROADMAP: Phase 35 (^plugin-voice-promptview-mic).
 */

/** Whether the current webview can capture audio at all. */
export function mediaRecorderSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}