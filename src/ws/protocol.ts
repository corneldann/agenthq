/**
 * WebSocket message protocol types and parser.
 *
 * Runtime-agnostic — no Bun imports. Safe to use in any environment.
 */

import type { SSEUpdateEvent } from '../types.js';

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'subscribe';    workspaceId?: string; chainId?: string; commandId: string }
  | { type: 'unsubscribe';  subscriptionId: string; commandId: string }
  | { type: 'ping';         commandId: string }
  | { type: 'cancel-job';   jobId: string; workspaceId: string; commandId: string }
  | { type: 'pause-agent';  sessionHash: string; workspaceId: string; commandId: string }
  | { type: 'resume-agent'; sessionHash: string; workspaceId: string; commandId: string };

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export type ServerMessage =
  | { type: 'connected';     clientId: string; workspaceIds: string[] }
  | { type: 'pong';          commandId: string; timestamp: string }
  | { type: 'ack';           commandId: string; success: boolean; error?: string; subscriptionId?: string }
  | { type: 'update';        event: SSEUpdateEvent }
  | { type: 'user-action';   userId: string; action: string; target: string; timestamp: string }
  | { type: 'status-change'; jobId: string; oldStatus: string; newStatus: string; timestamp: string; success: boolean; workspaceId: string }
  | { type: 'command-error'; userId: string; commandId: string; error: string }
  | { type: 'error';         code: number; message: string; commandId?: string };

// ---------------------------------------------------------------------------
// Result wrapper
// ---------------------------------------------------------------------------

export interface Result<T> {
  success: boolean;
  value?: T;
  error?: string;
}

// ---------------------------------------------------------------------------
// commandId format: cmd_<digits>_<lowercase-alphanum>
// ---------------------------------------------------------------------------

const COMMAND_ID_RE = /^cmd_\d+_[a-z0-9]+$/;

// ---------------------------------------------------------------------------
// parseClientMessage
// ---------------------------------------------------------------------------

/**
 * Parses and validates a raw (unknown) value as a {@link ClientMessage}.
 *
 * Returns `{ success: true, value }` on success or
 * `{ success: false, error }` describing the first validation failure.
 */
export function parseClientMessage(raw: unknown): Result<ClientMessage> {
  if (typeof raw !== 'object' || raw === null) {
    return { success: false, error: 'Message must be an object' };
  }

  const msg = raw as Record<string, unknown>;

  if (typeof msg['type'] !== 'string') {
    return { success: false, error: 'Missing or invalid type field' };
  }

  if (typeof msg['commandId'] !== 'string') {
    return { success: false, error: 'Missing or invalid commandId field' };
  }

  if (!COMMAND_ID_RE.test(msg['commandId'])) {
    return { success: false, error: 'Invalid commandId format' };
  }

  const type = msg['type'];

  switch (type) {
    case 'subscribe': {
      if (msg['workspaceId'] !== undefined && typeof msg['workspaceId'] !== 'string') {
        return { success: false, error: 'Invalid workspaceId field' };
      }
      if (msg['chainId'] !== undefined && typeof msg['chainId'] !== 'string') {
        return { success: false, error: 'Invalid chainId field' };
      }
      return { success: true, value: msg as unknown as ClientMessage };
    }

    case 'unsubscribe': {
      if (typeof msg['subscriptionId'] !== 'string') {
        return { success: false, error: 'Missing subscriptionId' };
      }
      return { success: true, value: msg as unknown as ClientMessage };
    }

    case 'ping': {
      return { success: true, value: msg as unknown as ClientMessage };
    }

    case 'cancel-job': {
      if (typeof msg['jobId'] !== 'string' || typeof msg['workspaceId'] !== 'string') {
        return { success: false, error: 'Missing jobId or workspaceId' };
      }
      return { success: true, value: msg as unknown as ClientMessage };
    }

    case 'pause-agent':
    case 'resume-agent': {
      if (typeof msg['sessionHash'] !== 'string' || typeof msg['workspaceId'] !== 'string') {
        return { success: false, error: 'Missing sessionHash or workspaceId' };
      }
      return { success: true, value: msg as unknown as ClientMessage };
    }

    default:
      return { success: false, error: 'Unknown message type' };
  }
}
