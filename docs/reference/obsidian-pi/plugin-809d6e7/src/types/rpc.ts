/**
 * Typed RPC protocol layer.
 *
 * These types mirror the pi RPC spec documented in rpc.md.  They are kept
 * deliberately self-contained (no imports from the pi npm package) so the
 * plugin stays lightweight.
 */

// ─── Shared primitives ──────────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ImageContent {
  type: 'image';
  data: string;       // base64
  mimeType: string;
}

// Chat-era commands (steer/follow_up/abort/new_session/get_state/models/
// steering modes/compact/bash/session stats/fork/clone/…) were removed from
// the plugin (AUDIT §6.1) — the plugin never sends them. The union keeps only
// what RpcClient.send() can emit; pi's remaining RPC commands are simply
// ignored by the client.
export type RpcCommand =
  | { type: 'prompt';           id?: string; message: string; images?: ImageContent[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'get_commands';     id?: string };

// ─── Responses (stdout) ─────────────────────────────────────────────────────

export interface RpcSuccessResponse<T = unknown> {
  type: 'response';
  id?: string;
  command: string;
  success: true;
  data?: T;
}

export interface RpcErrorResponse {
  type: 'response';
  id?: string;
  command: string;
  success: false;
  error: string;
}

export type RpcResponse<T = unknown> = RpcSuccessResponse<T> | RpcErrorResponse;

// ─── Events (stdout, no id) ──────────────────────────────────────────────────

export type AssistantMessageEventType =
  | 'start' | 'text_start' | 'text_delta' | 'text_end'
  | 'thinking_start' | 'thinking_delta' | 'thinking_end'
  | 'toolcall_start' | 'toolcall_delta' | 'toolcall_end'
  | 'done' | 'error';

export interface AssistantMessageDelta {
  type: AssistantMessageEventType;
  contentIndex?: number;
  delta?: string;
  partial?: unknown;
  content?: string;
  thinking?: string;
  toolCall?: unknown;
  reason?: string;
}

export type RpcEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: unknown[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: unknown; toolResults: unknown[] }
  | { type: 'message_start'; message: unknown }
  | { type: 'message_update'; message: unknown; assistantMessageEvent: AssistantMessageDelta }
  | { type: 'message_end'; message: unknown }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_update'; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | { type: 'compaction_end'; reason: string; result: unknown | null; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: 'auto_retry_start'; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  | { type: 'extension_error'; extensionPath: string; event: string; error: string };

// ─── Slash commands ──────────────────────────────────────────────────────────

export interface RpcSlashCommand {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
  location?: 'user' | 'project' | 'path';
  path?: string;
}
