/**
 * Deterministic tests for the AHP action → plugin RpcEvent mapping.
 *
 * Each test feeds a single AHP action of the form the live server echoes and
 * asserts the exact plugin notification shape ChatView/SessionPanel expect.
 */

import { describe, expect, it } from 'vitest';
import { mapAhpAction, type AhpActionContext } from './AhpActionMapper';
import type { RpcEvent } from '../types/rpc';

const TURN_ID = 'turn-abc';
const PART_ID = 'part-abc-text';
const TOOL_CALL_ID = 'tc-abc-bash';

const usageContext: AhpActionContext = {
  lastUsage: { input: 142, output: 89, cacheRead: 12, model: 'demo-model' },
};

describe('mapAhpAction', () => {
  it('maps chat/turnStarted to agent_start + assistant message_start', () => {
    const action = {
      type: 'chat/turnStarted',
      turnId: TURN_ID,
      message: {
        text: 'Summarize the project.',
        origin: { kind: 'user' },
        model: 'demo-model',
        agent: 'demo-agent',
      },
    };

    expect(mapAhpAction(action)).toEqual([
      { type: 'agent_start' },
      {
        type: 'message_start',
        message: {
          role: 'assistant',
          text: 'Summarize the project.',
          model: 'demo-model',
          agent: 'demo-agent',
        },
      },
    ] satisfies RpcEvent[]);
  });

  it('maps chat/delta to message_update text_delta', () => {
    const action = { type: 'chat/delta', turnId: TURN_ID, partId: PART_ID, content: 'Hello' };

    expect(mapAhpAction(action)).toEqual([
      {
        type: 'message_update',
        message: {},
        assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
      },
    ] satisfies RpcEvent[]);
  });

  it('maps chat/toolCallStart to tool_execution_start', () => {
    const action = {
      type: 'chat/toolCallStart',
      turnId: TURN_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'bash',
      displayName: 'Run terminal command',
      intention: 'List files',
    };

    expect(mapAhpAction(action)).toEqual([
      {
        type: 'tool_execution_start',
        toolCallId: TOOL_CALL_ID,
        toolName: 'bash',
        args: { displayName: 'Run terminal command', intention: 'List files' },
      },
    ] satisfies RpcEvent[]);
  });

  it('maps chat/toolCallComplete to tool_execution_end (success)', () => {
    const action = {
      type: 'chat/toolCallComplete',
      turnId: TURN_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: 'bash',
      result: {
        success: true,
        pastTenseMessage: 'Listed files.',
        content: [{ type: 'text', text: 'file.txt' }],
      },
    };

    expect(mapAhpAction(action)).toEqual([
      {
        type: 'tool_execution_end',
        toolCallId: TOOL_CALL_ID,
        toolName: 'bash',
        result: {
          success: true,
          pastTenseMessage: 'Listed files.',
          content: [{ type: 'text', text: 'file.txt' }],
        },
        isError: false,
      },
    ] satisfies RpcEvent[]);
  });

  it('maps chat/toolCallComplete failure to tool_execution_end with isError true', () => {
    const action = {
      type: 'chat/toolCallComplete',
      turnId: TURN_ID,
      toolCallId: TOOL_CALL_ID,
      result: { success: false, pastTenseMessage: 'Command failed.', content: [] },
    };

    const events = mapAhpAction(action);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_execution_end', isError: true });
  });

  it('maps chat/usage to no direct event (cached for stats)', () => {
    const action = {
      type: 'chat/usage',
      turnId: TURN_ID,
      usage: { inputTokens: 142, outputTokens: 89, model: 'demo-model', cacheReadTokens: 12 },
    };

    expect(mapAhpAction(action)).toEqual([]);
  });

  it('maps chat/turnComplete to message_end + turn_end + agent_end', () => {
    const action = { type: 'chat/turnComplete', turnId: TURN_ID };

    expect(mapAhpAction(action, usageContext)).toEqual([
      { type: 'message_end', message: {} },
      { type: 'turn_end', message: { stopReason: 'stop' }, toolResults: [] },
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            stopReason: 'stop',
            usage: { input: 142, output: 89, cost: { total: 0 } },
          },
        ],
      },
    ] satisfies RpcEvent[]);
  });

  it('ignores unknown action types', () => {
    expect(mapAhpAction({ type: 'root/activeSessionsChanged' })).toEqual([]);
  });

  it('maps session/chat* mutations to no terminal events (routed to sessionChatSubs by AhpClient)', () => {
    expect(mapAhpAction({ type: 'session/chatAdded', summary: { resource: 'ahp-chat:/c1' } })).toEqual([]);
    expect(mapAhpAction({ type: 'session/chatUpdated', chat: 'ahp-chat:/c1', changes: {} })).toEqual([]);
    expect(mapAhpAction({ type: 'session/chatRemoved', chat: 'ahp-chat:/c1' })).toEqual([]);
  });
});
