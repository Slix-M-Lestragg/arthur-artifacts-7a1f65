/**
 * Real-time streaming dictation client.
 *
 * Captures microphone audio through the Web Audio API, downsamples to 16 kHz
 * mono Float32 PCM, and streams it to the Whisper STT sidecar over a WebSocket.
 * Server JSON updates (throttled) are fed back to the caller as live partial
 * transcripts.
 *
 * Uses ScriptProcessorNode so it can be bundled without a separate AudioWorklet
 * file. AudioWorklet is a future improvement for lower overhead.
 */

import { mediaRecorderSupported } from './stt';

export type StreamUpdate = (text: string, done: boolean) => void;

export class MicStreamer {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freqData: Uint8Array<ArrayBuffer> | null = null;
  private rafId: number | null = null;
  private closeTimer: number | null = null;
  private update: StreamUpdate;
  readonly sampleRate = 16000;

  constructor(update: StreamUpdate) {
    this.update = update;
  }

  async start(opts: {
    url: string;
    token: string;
    lang: 'auto' | 'en' | 'fr';
    model?: string;
    onLevel?: (levels: Uint8Array<ArrayBuffer>) => void;
  }): Promise<void> {
    if (!mediaRecorderSupported()) {
      throw new Error('Audio capture not available in this webview.');
    }

    // Convert http(s):// -> ws(s):// and append the streaming endpoint.
    const wsBase = opts.url.replace(/^http/, 'ws').replace(/\/+$/, '');
    const q = new URLSearchParams({
      token: opts.token || '',
      lang: opts.lang || 'auto',
    });
    if (opts.model) q.set('model', opts.model);

    this.ws = new WebSocket(`${wsBase}/transcribe/stream?${q.toString()}`);
    this.ws.binaryType = 'arraybuffer';
    let chunkCount = 0;
    this.ws.onmessage = (e: MessageEvent) => {
      try {
        const j = JSON.parse(typeof e.data === 'string' ? e.data : '');
        if (typeof j.text === 'string') {
          this.update(j.text, !!j.done);
          if (j.done) {
            this.close();
          }
        }
      } catch {
        /* ignore malformed frames */
      }
    };
    this.ws.onclose = () => this.close();
    this.ws.onerror = () => this.close();
    await this._waitOpen(this.ws);

    // Audio capture.
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new AudioContext(); // default sample rate (often 48000)
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { /* ignore */ }
    }
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;            // -> 128 frequency bins
    this.analyser.smoothingTimeConstant = 0.7;
    this.freqData = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
    this.source.connect(this.analyser);    // passive tap
    if (opts.onLevel) this.startLevelLoop(opts.onLevel);

    this.node = this.ctx.createScriptProcessor(4096, 1, 1); // mono
    const ratio = this.ctx.sampleRate / this.sampleRate;

    this.node.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const input = e.inputBuffer.getChannelData(0); // mono (channel 0)

      // Downsample to 16 kHz by averaging windows of `ratio` samples.
      const outLen = Math.max(1, Math.floor(input.length / ratio));
      const out = new Float32Array(outLen);
      for (let o = 0; o < outLen; o++) {
        const startI = Math.floor(o * ratio);
        const endI = Math.min(input.length, Math.floor((o + 1) * ratio));
        let s = 0;
        let n = 0;
        for (let i = startI; i < endI; i++) {
          s += input[i];
          n++;
        }
        out[o] = n ? s / n : 0;
      }
      this.ws.send(out.buffer); // binary Float32 LE PCM
      chunkCount++;
    };

    this.source.connect(this.node);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
  }

  isRecording(): boolean {
    return !!this.node && !!this.ws;
  }

  stop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.freqData = null;
    try {
      this.analyser?.disconnect();
    } catch {
      /* ignore */
    }
    this.analyser = null;
    try {
      this.node?.disconnect();
    } catch {
      /* ignore */
    }
    this.node = null;
    try {
      this.source?.disconnect();
    } catch {
      /* ignore */
    }
    this.source = null;
    try {
      this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;

    // Tell the server to flush and send the final transcript, but keep the
    // WebSocket open until the done:true arrives (or a timeout).
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(new ArrayBuffer(0));
      } catch {
        /* ignore */
      }
    }
    if (this.closeTimer === null) {
      this.closeTimer = window.setTimeout(() => this.close(), 3000);
    }
  }

  /** Idempotent cleanup: clear the fallback timer and close the WebSocket. */
  close(): void {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.ws) {
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.close();
        }
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private startLevelLoop(onLevel: (levels: Uint8Array<ArrayBuffer>) => void): void {
    const loop = () => {
      if (!this.analyser || !this.freqData) return;
      this.analyser.getByteFrequencyData(this.freqData);
      onLevel(this.freqData);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private _waitOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.readyState === WebSocket.OPEN) return resolve();
      ws.onopen = () => resolve();
      ws.onerror = () =>
        reject(
          new Error(
            'could not open transcription WebSocket (check STT server URL + token)',
          ),
        );
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          reject(new Error('WS open timeout'));
        }
      }, 8000);
    });
  }
}
