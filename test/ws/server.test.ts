/**
 * Unit tests for WsServer (src/ws/server.ts).
 *
 * Uses a mock ServerWebSocket (plain object with send/close spies) wired to a
 * real SubscriptionManager and a CommandHandler backed by a stub DbAdapter.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 9.1, 11.2
 */

import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { WsServer, type WsServerConfig } from '../../src/ws/server';
import { SubscriptionManager } from '../../src/ws/subscriptions';
import { CommandHandler } from '../../src/ws/commands';
import type { DbAdapter } from '../../src/db/adapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Track all send and close calls from a mock WebSocket. */
type MockWsState = {
  sends: string[];
  closeArgs: Array<[code?: number, reason?: string]>;
};

/** Build a mock ServerWebSocket with a predetermined clientId. */
function makeMockWs(clientId: string): {
  ws: ServerWebSocket<{ clientId: string }>;
  state: MockWsState;
} {
  const state: MockWsState = { sends: [], closeArgs: [] };
  const ws = {
    data: { clientId },
    send: (payload: string) => {
      state.sends.push(payload);
    },
    close: (code?: number, reason?: string) => {
      state.closeArgs.push([code, reason]);
    },
  } as unknown as ServerWebSocket<{ clientId: string }>;
  return { ws, state };
}

/**
 * Stub DbAdapter whose query() returns empty rows by default, simulating a
 * "not found" response for all CommandHandler queries.
 */
function makeEmptyDb(): DbAdapter {
  return {
    query: async <T>() => ({ rows: [] as T[], rowCount: 0 }),
    execute: async () => ({ rowsAffected: 0 }),
    transaction: async () => {},
    close: async () => {},
  };
}

/** Create a WsServer with a real SubscriptionManager and an empty-stub DbAdapter. */
function makeServer(config: Partial<WsServerConfig> = {}): {
  server: WsServer;
  mgr: SubscriptionManager;
  commandHandler: CommandHandler;
} {
  const fullConfig: WsServerConfig = {
    idleTimeout: 30,
    maxMessageSize: 1024,
    ...config,
  };
  const mgr = new SubscriptionManager();
  const commandHandler = new CommandHandler(makeEmptyDb());
  const server = new WsServer(fullConfig, mgr, commandHandler);
  return { server, mgr, commandHandler };
}

/** Generate a valid commandId. */
function commandId(n = 1): string {
  return `cmd_${Date.now() + n}_abc123`;
}

// ---------------------------------------------------------------------------
// open()
// ---------------------------------------------------------------------------

describe('WsServer — open()', () => {
  it('should call addClient with the clientId from ws.data', () => {
    const { server, mgr } = makeServer();
    const { ws } = makeMockWs('client-open-1');

    server.open(ws);

    const client = mgr.getClient('client-open-1');
    expect(client).toBeDefined();
    expect(client?.id).toBe('client-open-1');
  });

  it('should send a JSON message with type "connected" and the clientId', () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-open-2');

    server.open(ws);

    expect(state.sends).toHaveLength(1);
    const msg = JSON.parse(state.sends[0]);
    expect(msg.type).toBe('connected');
    expect(msg.clientId).toBe('client-open-2');
  });

  it('should include an empty workspaceIds array in the connected message', () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-open-3');

    server.open(ws);

    const msg = JSON.parse(state.sends[0]);
    expect(Array.isArray(msg.workspaceIds)).toBe(true);
    expect(msg.workspaceIds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// message() — binary frame rejection
// ---------------------------------------------------------------------------

describe('WsServer — message() with binary input', () => {
  it('should close the connection with code 1003 when a Buffer message is received', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-binary');
    server.open(ws);

    await server.message(ws, Buffer.from('binary data'));

    expect(state.closeArgs).toHaveLength(1);
    expect(state.closeArgs[0][0]).toBe(1003);
    expect(state.sends).toHaveLength(1); // only the 'connected' message from open()
  });
});

// ---------------------------------------------------------------------------
// message() — oversized message
// ---------------------------------------------------------------------------

describe('WsServer — message() with oversized payload', () => {
  it('should send an error with code 413 when the message length exceeds maxMessageSize', async () => {
    const { server } = makeServer({ maxMessageSize: 10 });
    const { ws, state } = makeMockWs('client-big');
    server.open(ws);

    const oversized = 'x'.repeat(11);
    await server.message(ws, oversized);

    // The last send should be the 413 error (first was 'connected').
    const errorMsg = JSON.parse(state.sends[state.sends.length - 1]);
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.code).toBe(413);
  });

  it('should not close the connection when message is too large', async () => {
    const { server } = makeServer({ maxMessageSize: 10 });
    const { ws, state } = makeMockWs('client-big-noclose');
    server.open(ws);

    await server.message(ws, 'x'.repeat(11));

    expect(state.closeArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// message() — invalid JSON
// ---------------------------------------------------------------------------

describe('WsServer — message() with invalid JSON', () => {
  it('should close the connection with code 1003 when the message is not valid JSON', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-badjson');
    server.open(ws);

    await server.message(ws, '{not valid json}');

    expect(state.closeArgs).toHaveLength(1);
    expect(state.closeArgs[0][0]).toBe(1003);
  });

  it('should not send an error response when JSON parse fails (connection is closed instead)', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-badjson2');
    server.open(ws);
    const sendsBefore = state.sends.length;

    await server.message(ws, '}{');

    // No additional send beyond what open() produced.
    expect(state.sends.length).toBe(sendsBefore);
  });
});

// ---------------------------------------------------------------------------
// message() — invalid message structure
// ---------------------------------------------------------------------------

describe('WsServer — message() with invalid message structure', () => {
  it('should send an error with code 400 when commandId format is invalid', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-badcmd');
    server.open(ws);

    const invalidMsg = JSON.stringify({ type: 'ping', commandId: 'BAD_ID' });
    await server.message(ws, invalidMsg);

    const errorMsg = JSON.parse(state.sends[state.sends.length - 1]);
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.code).toBe(400);
  });

  it('should send an error with code 400 when the type field is missing', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-notype');
    server.open(ws);

    const invalidMsg = JSON.stringify({ commandId: `cmd_${Date.now()}_abc` });
    await server.message(ws, invalidMsg);

    const errorMsg = JSON.parse(state.sends[state.sends.length - 1]);
    expect(errorMsg.type).toBe('error');
    expect(errorMsg.code).toBe(400);
  });

  it('should not close the connection when the message structure is invalid', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-badstruct');
    server.open(ws);

    await server.message(ws, JSON.stringify({ type: 'ping', commandId: 'NOT_VALID' }));

    expect(state.closeArgs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// message() — ping → pong
// ---------------------------------------------------------------------------

describe('WsServer — message() with ping', () => {
  it('should send a pong message with the matching commandId', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-ping');
    server.open(ws);

    const cid = commandId(1);
    await server.message(ws, JSON.stringify({ type: 'ping', commandId: cid }));

    const pong = JSON.parse(state.sends[state.sends.length - 1]);
    expect(pong.type).toBe('pong');
    expect(pong.commandId).toBe(cid);
  });

  it('should include a timestamp string in the pong response', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-ping-ts');
    server.open(ws);

    await server.message(ws, JSON.stringify({ type: 'ping', commandId: commandId(2) }));

    const pong = JSON.parse(state.sends[state.sends.length - 1]);
    expect(typeof pong.timestamp).toBe('string');
    expect(pong.timestamp).toContain('T');
  });
});

// ---------------------------------------------------------------------------
// message() — subscribe → ack
// ---------------------------------------------------------------------------

describe('WsServer — message() with subscribe', () => {
  it('should send an ack with success: true and a non-empty subscriptionId', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-sub');
    server.open(ws);

    const cid = commandId(3);
    await server.message(ws, JSON.stringify({
      type: 'subscribe',
      workspaceId: 'ws-1',
      commandId: cid,
    }));

    const ack = JSON.parse(state.sends[state.sends.length - 1]);
    expect(ack.type).toBe('ack');
    expect(ack.commandId).toBe(cid);
    expect(ack.success).toBe(true);
    expect(typeof ack.subscriptionId).toBe('string');
    expect(ack.subscriptionId.length).toBeGreaterThan(0);
  });

  it('should register the subscription in the SubscriptionManager', async () => {
    const { server, mgr } = makeServer();
    const { ws } = makeMockWs('client-sub-reg');
    server.open(ws);

    await server.message(ws, JSON.stringify({
      type: 'subscribe',
      workspaceId: 'ws-check',
      commandId: commandId(4),
    }));

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-check' });
    expect(interested).toHaveLength(1);
    expect(interested[0].id).toBe('client-sub-reg');
  });
});

// ---------------------------------------------------------------------------
// message() — cancel-job → ack
// ---------------------------------------------------------------------------

describe('WsServer — message() with cancel-job', () => {
  it('should call commandHandler.handle and send an ack matching the result', async () => {
    const { server } = makeServer();
    const { ws, state } = makeMockWs('client-cancel');
    server.open(ws);

    const cid = commandId(5);
    await server.message(ws, JSON.stringify({
      type: 'cancel-job',
      jobId: 'job-does-not-exist',
      workspaceId: 'ws-1',
      commandId: cid,
    }));

    // The stub DbAdapter returns empty rows → CommandHandler returns 'not found'.
    const ack = JSON.parse(state.sends[state.sends.length - 1]);
    expect(ack.type).toBe('ack');
    expect(ack.commandId).toBe(cid);
    expect(ack.success).toBe(false);
    expect(ack.error).toBe('not found');
  });

  it('should send an ack with success: true when commandHandler resolves successfully', async () => {
    const { server, mgr } = makeServer();

    // Build a stub DbAdapter that simulates a found job so cancel succeeds.
    const successDb: DbAdapter = {
      query: async <T>() => ({
        rows: [{ id: 'job-1', workspace_id: 'ws-1', status: 'running' }] as T[],
        rowCount: 1,
      }),
      execute: async () => ({ rowsAffected: 1 }),
      transaction: async (fn) => {
        await fn({
          query: async <T>() => ({ rows: [] as T[], rowCount: 0 }),
          execute: async () => ({ rowsAffected: 1 }),
          transaction: async () => {},
          close: async () => {},
        });
      },
      close: async () => {},
    };

    const successHandler = new CommandHandler(successDb);
    const successServer = new WsServer(
      { idleTimeout: 30, maxMessageSize: 4096 },
      new SubscriptionManager(),
      successHandler,
    );

    const { ws, state } = makeMockWs('client-cancel-ok');
    successServer.open(ws);

    const cid = commandId(6);
    await successServer.message(ws, JSON.stringify({
      type: 'cancel-job',
      jobId: 'job-1',
      workspaceId: 'ws-1',
      commandId: cid,
    }));

    const ack = JSON.parse(state.sends[state.sends.length - 1]);
    expect(ack.type).toBe('ack');
    expect(ack.commandId).toBe(cid);
    expect(ack.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// close()
// ---------------------------------------------------------------------------

describe('WsServer — close()', () => {
  it('should call removeClient with the clientId when the connection closes', () => {
    const { server, mgr } = makeServer();
    const { ws } = makeMockWs('client-close-1');
    server.open(ws);

    // Confirm client is registered before close.
    expect(mgr.getClient('client-close-1')).toBeDefined();

    server.close(ws);

    expect(mgr.getClient('client-close-1')).toBeUndefined();
  });

  it('should not throw when removeClient is called for a client that was already removed', () => {
    const { server, mgr } = makeServer();
    const { ws } = makeMockWs('client-close-2');
    server.open(ws);
    mgr.removeClient('client-close-2'); // Manually remove first.

    // Second removal via close() must not throw.
    expect(() => server.close(ws)).not.toThrow();
  });

  it('should remove all subscriptions belonging to the closing client', async () => {
    const { server, mgr } = makeServer();
    const { ws } = makeMockWs('client-close-sub');
    server.open(ws);

    // Subscribe so there is something to clean up.
    await server.message(ws, JSON.stringify({
      type: 'subscribe',
      workspaceId: 'ws-cleanup',
      commandId: commandId(7),
    }));

    server.close(ws);

    const interested = mgr.getInterestedClients({ workspaceId: 'ws-cleanup' });
    expect(interested).toHaveLength(0);
  });
});
