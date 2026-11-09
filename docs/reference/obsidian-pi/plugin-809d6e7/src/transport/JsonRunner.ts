/**
 * JsonRunner — one-shot runner for `pi --mode json`.
 *
 * Spawns the pi subprocess in JSON mode, pipes a prompt as a positional argument,
 * collects the event stream to completion, and resolves with the accumulated
 * assistant text + all events.  Unlike RpcClient, this is fire-and-forget:
 * no stdin interaction, no id correlation, process exits when done.
 */

import { spawn } from 'child_process';
import { attachJsonlReader } from './JsonlCodec';
import type { BinaryInfo } from '../binary';

// ─── Public API ──────────────────────────────────────────────────────────────

export interface JsonRunnerOptions {
  binaryInfo: BinaryInfo;
  cwd?: string;
  model?: string;
  thinkingLevel?: string;
  agentDir?: string;
  env?: Record<string, string>;
  /** Don't save the session (ephemeral). Default: true. */
  noSession?: boolean;
  /** Kill the subprocess if it hasn't exited after this long. Default: 10 minutes. */
  timeoutMs?: number;
}

export interface JsonRunResult {
  /** Accumulated assistant text from text_delta events. */
  text: string;
  /** All messages from the agent_end event. */
  messages: unknown[];
  /** Every parsed event (for debugging / advanced consumers). */
  events: unknown[];
  /** Process exit code. */
  exitCode: number | null;
  /** Collected stderr output. */
  stderr: string;
  /** Set if the process failed to spawn or exited with error. */
  error?: string;
}

// ─── JsonRunner ──────────────────────────────────────────────────────────────

export class JsonRunner {
  constructor(private readonly options: JsonRunnerOptions) {}

  /**
   * Run a one-shot prompt in JSON mode and collect all events to completion.
   * Resolves when the pi process exits.
   */
  async run(prompt: string, signal?: AbortSignal): Promise<JsonRunResult> {
    const { binaryInfo, cwd, model, thinkingLevel, agentDir, env, noSession, timeoutMs } = this.options;

    const rpcArgs: string[] = ['--mode', 'json'];
    if (model)         rpcArgs.push('--model', model);
    if (thinkingLevel) rpcArgs.push('--thinking', thinkingLevel);
    if (agentDir)      rpcArgs.push('--agent-dir', agentDir);
    if (noSession !== false) rpcArgs.push('--no-session');
    rpcArgs.push(prompt);

    const exe = binaryInfo.nodeExe ?? binaryInfo.path;
    const fullArgs = binaryInfo.nodeExe ? [binaryInfo.path, ...rpcArgs] : rpcArgs;
    const childEnv = { ...process.env, ...env };

    return new Promise<JsonRunResult>((resolve) => {
      const child = spawn(exe, fullArgs, {
        cwd,
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stderr = '';
      let text = '';
      const events: unknown[] = [];
      let messages: unknown[] = [];
      let timedOut = false;
      let aborted = false;

      // Guard against a hung pi process — without this the caller's "Running…"
      // notice never resolves and the child leaks.
      const killChild = () => {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* fine */ } }, 2_000);
      };
      const timer = setTimeout(() => { timedOut = true; killChild(); }, timeoutMs ?? 600_000);
      const onAbort = () => { aborted = true; killChild(); };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-16_384); });

      attachJsonlReader(child.stdout, (line) => {
        if (!line) return;
        try {
          const data = JSON.parse(line) as Record<string, unknown>;
          // Skip the session header line.
          if (data['type'] === 'session') return;
          events.push(data);

          if (data['type'] === 'message_update') {
            const delta = data['assistantMessageEvent'] as { type?: string; delta?: string } | undefined;
            if (delta?.type === 'text_delta' && delta.delta) {
              text += delta.delta;
            }
          }

          if (data['type'] === 'agent_end') {
            messages = (data['messages'] as unknown[]) ?? [];
          }
        } catch {
          // Ignore non-JSON lines.
        }
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const error = timedOut
          ? `pi run timed out after ${timeoutMs ?? 600_000}ms`
          : aborted ? 'pi run aborted' : undefined;
        resolve({ text, messages, events, exitCode: code, stderr, ...(error ? { error } : {}) });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({ text, messages, events, exitCode: null, stderr, error: err.message });
      });

      // Close stdin — JSON mode doesn't need interactive input.
      child.stdin.end();
    });
  }
}