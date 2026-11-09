/**
 * AhpActionMapper — translate AHP channel actions into the plugin's existing
 * RpcEvent shape so the AHP terminal adapter (AhpTerminalAdapter) consumes a
 * remote AHP session through the same event stream ChatView once used.
 *
 * This is intentionally a pure, side-effect-free map from a single AHP action
 * to the ordered list of plugin events the terminal adapter expects.  State/usage that
 * spans actions (e.g. the latest usage report) is tracked by AhpClient and
 * folded into the synthetic `agent_end` message via the optional `context`.
 */

import type { RpcEvent } from '../types/rpc';

export interface AhpActionContext {
  /** Last `chat/usage` report, folded into the synthetic turn summary. */
  lastUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    model: string;
  };
}

function syntheticAssistantMessage(context?: AhpActionContext): unknown {
  return {
    role: 'assistant',
    stopReason: 'stop',
    usage: {
      input: context?.lastUsage?.input ?? 0,
      output: context?.lastUsage?.output ?? 0,
      cost: { total: 0 },
    },
  };
}

function modelString(model: unknown): string | undefined {
  if (typeof model === 'string') return model;
  const m = model as { id?: string } | undefined;
  return m?.id;
}

export function mapAhpAction(action: Record<string, unknown>, context?: AhpActionContext): RpcEvent[] {
  const type = action.type as string | undefined;
  switch (type) {
    case 'chat/turnStarted': {
      const message = (action.message ?? {}) as Record<string, unknown>;
      return [
        { type: 'agent_start' },
        {
          type: 'message_start',
          message: {
            role: 'assistant',
            text: message.text,
            model: modelString(message.model),
            agent: typeof message.agent === 'string' ? message.agent : undefined,
          },
        },
      ];
    }
    case 'chat/delta': {
      const content = (action.content as string) ?? '';
      return [
        {
          type: 'message_update',
          message: {},
          assistantMessageEvent: { type: 'text_delta', delta: content },
        },
      ];
    }
    case 'chat/toolCallStart': {
      return [
        {
          type: 'tool_execution_start',
          toolCallId: action.toolCallId as string,
          toolName: action.toolName as string,
          args: {
            displayName: action.displayName,
            intention: action.intention,
          },
        },
      ];
    }
    case 'chat/toolCallComplete': {
      const result = action.result as Record<string, unknown> | undefined;
      const isError = result?.success === false;
      return [
        {
          type: 'tool_execution_end',
          toolCallId: action.toolCallId as string,
          toolName: action.toolName as string,
          result,
          isError,
        },
      ];
    }
    case 'chat/usage': {
      // No direct terminal event; AhpClient caches this for get_session_stats().
      return [];
    }
    case 'chat/turnComplete': {
      return [
        { type: 'message_end', message: {} },
        { type: 'turn_end', message: { stopReason: 'stop' }, toolResults: [] },
        { type: 'agent_end', messages: [syntheticAssistantMessage(context)] },
      ];
    }
    case 'session/chatAdded':
    case 'session/chatUpdated':
    case 'session/chatRemoved': {
      // Server-originated chat-list mutations (dispatchServerAction). These are
      // NOT part of the terminal event stream — AhpClient routes them to the
      // sessionChat subscription handlers (FarmView's live subagent rows) in
      // applyActionEnvelope. Documented here so the wire contract is explicit
      // and they don't silently fall into the unknown-action default.
      //   chatAdded:   { summary: ChatSummary }
      //   chatUpdated: { chat: URI, changes: Partial<ChatSummary> }
      //   chatRemoved: { chat: URI }
      return [];
    }
    default:
      return [];
  }
}
