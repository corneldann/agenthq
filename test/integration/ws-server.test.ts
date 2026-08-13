/**
 * Integration tests for the full WebSocket flow.
 *
 * Spins up a real Bun HTTP server with an in-memory SQLite database,
 * real migrations via `runMigrations()`, and the complete WsServer stack.
 * Tests connect via a real WebSocket client and validate end-to-end message
 * handling.
 *
 * Validates: Requirements 1.3, 1.4, 1.7, 3.1, 4.5, 5.4, 11.2, 11.3
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { join } from 'path';
import { SQLiteAdapter } from '../../src/db/sqlite-adapter';
import { runMigrations } from '../../src/db/migrations';
import { SubscriptionManager } from '../../src/ws/subscriptions';
import { CommandHandler } from '../../src/ws/commands';
import { WsServer, type WsServerConfig } from '../../src/ws/server';

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let bunServer: ReturnType<typeof Bun.serve>;
let port: number;

let db: SQLiteAdapter;
let subscriptionMgr: SubscriptionManager;
let commandHandler: CommandHandler;
let wsServer: WsServer;

const WS_CONFIG: WsServerConfig = {
  idleTimeout: 30,
  maxMessageSize: 65536,
};

/** Absolute path to the migrations directory (relative to this repo root). */
const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations');

beforeAll(async () => {
  // ── In-memory database with schema applied via runMigrations() ──────────
  db = new SQLiteAdapter(':memory:');
  await runMigrations(db, MIGRATIONS_DIR);

  // ── WebSocket stack ────────────────────────────────────────────────────
  subscriptionMgr = new SubscriptionManager();
  commandHandler = new CommandHandler(db);
  wsServer = new WsServer(WS_CONFIG, subscriptionMgr, commandHandler);

  // ── Bun HTTP server on a random free port ──────────────────────────────
  bunServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/ws') {
        const result = wsServer.upgrade(req);
        return result ?? (undefined as unknown as Response);
      }
      return new Response('Not found', { status: 404 });
    },
    websocket: {
      open: (ws) => wsServer.open(ws as Parameters<typeof wsServer.open>[0]),
      message: (ws, msg) => wsServer.message(ws as Parameters<typeof wsServer.message>[0], msg),
      close: (ws) => wsServer.close(ws as Parameters<typeof wsServer.close>[0]),
      idleTimeout: WS_CONFIG.idleTimeout,
    },
  });

  // Inject the live server handle so WsServer.upgrade() can call server.upgrade()
  wsServer.setServer(bunServer as Parameters<typeof wsServer.setServer>[0]);

  port = bunServer.port ?? 0;
});

afterAll(async () => {
  bunServer?.stop(true);
  await db?.close();
});

// ---------------------------------------------------------------------------
// Helper — connect and wait for the initial "connected" message
// ---------------------------------------------------------------------------

/**
 * Open a WebSocket connection to the test server and wait until the
 * `connected` message arrives (or reject after a timeout).
 *
 * @param p The server port to connect to
 * @returns The connected WebSocket instance
 */
async function connect(p: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${p}/ws`);

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('connect timeout: no "connected" message within 2s'));
    }, 2000);

    ws.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'connected') {
          clearTimeout(timeout);
          resolve(ws);
        }
      } catch {
        // Ignore parse errors during handshake
      }
    });

    ws.addEventListener('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Wait for the next message on an open WebSocket and parse it as JSON.
 *
 * @param ws      Open WebSocket instance
 * @param timeout Max wait time in milliseconds (default 2000)
 */
function nextMessage(ws: WebSocket, timeout = 2000): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = setTimeout(() => {
      reject(new Error(`nextMessage timeout after ${timeout}ms`));
    }, timeout);

    ws.addEventListener(
      'message',
      (event) => {
        clearTimeout(id);
        resolve(JSON.parse(event.data as string) as Record<string, unknown>);
      },
      { once: true },
    );
  });
}

/** Generate a valid commandId in the required format. */
function makeCommandId(): string {
  return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

// ---------------------------------------------------------------------------
// Test: connect → receive "connected" message
// ---------------------------------------------------------------------------

describe('WebSocket integration — connect (Requirement 1.3)', () => {
  it('should receive a "connected" message with a non-empty clientId on connect', async () => {
    // Arrange: track the connected message before connect() resolves
    const wsRaw = new WebSocket(`ws://localhost:${port}/ws`);
    let connectedMsg: Record<string, unknown> | undefined;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        wsRaw.close();
        reject(new Error('timeout waiting for connected message'));
      }, 2000);

      wsRaw.addEventListener('message', (event) => {
        try {
          const msg = JSON.parse(event.data as string) as Record<string, unknown>;
          if (msg.type === 'connected') {
            clearTimeout(t);
            connectedMsg = msg;
            resolve();
          }
        } catch {
          // ignore
        }
      });
    });

    // Act / Assert
    expect(connectedMsg).toBeDefined();
    expect(connectedMsg!.type).toBe('connected');
    expect(typeof connectedMsg!.clientId).toBe('string');
    expect((connectedMsg!.clientId as string).length).toBeGreaterThan(0);

    wsRaw.close();
  });
});

// ---------------------------------------------------------------------------
// Test: subscribe → ack with subscriptionId
// ---------------------------------------------------------------------------

describe('WebSocket integration — subscribe (Requirement 3.1)', () => {
  it('should receive an ack with success:true and a matching subscriptionId after subscribing', async () => {
    // Arrange
    const ws = await connect(port);
    const cmdId = makeCommandId();

    // Act
    ws.send(JSON.stringify({
      type: 'subscribe',
      workspaceId: 'ws-integration-test',
      commandId: cmdId,
    }));

    const ack = await nextMessage(ws);

    // Assert
    expect(ack.type).toBe('ack');
    expect(ack.commandId).toBe(cmdId);
    expect(ack.success).toBe(true);
    expect(typeof ack.subscriptionId).toBe('string');
    expect(/^sub_\d+_[a-z0-9]+$/.test(ack.subscriptionId as string)).toBe(true);

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Test: ping → pong with matching commandId
// ---------------------------------------------------------------------------

describe('WebSocket integration — ping/pong (Requirement 1.4)', () => {
  it('should receive a pong with the matching commandId in response to a ping', async () => {
    // Arrange
    const ws = await connect(port);
    const cmdId = makeCommandId();

    // Act
    ws.send(JSON.stringify({ type: 'ping', commandId: cmdId }));
    const pong = await nextMessage(ws);

    // Assert
    expect(pong.type).toBe('pong');
    expect(pong.commandId).toBe(cmdId);
    expect(typeof pong.timestamp).toBe('string');

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Test: cancel-job for non-existent jobId → ack with success:false
// ---------------------------------------------------------------------------

describe('WebSocket integration — cancel-job not found (Requirement 4.5)', () => {
  it('should receive an ack with success:false and error "not found" for a non-existent jobId', async () => {
    // Arrange
    const ws = await connect(port);
    const cmdId = makeCommandId();

    // Act
    ws.send(JSON.stringify({
      type: 'cancel-job',
      jobId: 'job-does-not-exist-integration',
      workspaceId: 'workspace-integration',
      commandId: cmdId,
    }));

    const ack = await nextMessage(ws);

    // Assert
    expect(ack.type).toBe('ack');
    expect(ack.commandId).toBe(cmdId);
    expect(ack.success).toBe(false);
    expect(ack.error).toBe('not found');

    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Test: 10 concurrent connections — all receive "connected"; all pings get pong
// ---------------------------------------------------------------------------

describe('WebSocket integration — concurrent connections (Requirements 1.7, 11.3)', () => {
  it('should handle 10 concurrent connections: each receives "connected" and a pong within 500ms', async () => {
    const startTime = Date.now();

    // Open 10 connections concurrently and collect the connected messages
    const connections = await Promise.all(
      Array.from({ length: 10 }, () => {
        return new Promise<{ ws: WebSocket; clientId: string }>((resolve, reject) => {
          const ws = new WebSocket(`ws://localhost:${port}/ws`);

          const t = setTimeout(() => {
            ws.close();
            reject(new Error('timeout waiting for "connected" message'));
          }, 500);

          ws.addEventListener('message', (event) => {
            try {
              const msg = JSON.parse(event.data as string) as Record<string, unknown>;
              if (msg.type === 'connected') {
                clearTimeout(t);
                resolve({ ws, clientId: msg.clientId as string });
              }
            } catch {
              clearTimeout(t);
              reject(new Error('failed to parse connected message'));
            }
          });

          ws.addEventListener('error', (err) => {
            clearTimeout(t);
            reject(err);
          });
        });
      }),
    );

    // All 10 must have received a "connected" message with a non-empty clientId
    expect(connections).toHaveLength(10);
    for (const { clientId } of connections) {
      expect(typeof clientId).toBe('string');
      expect(clientId.length).toBeGreaterThan(0);
    }

    // Send ping from each and collect pong responses concurrently
    const pingResults = await Promise.all(
      connections.map(({ ws }) => {
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          const cmdId = makeCommandId();

          const t = setTimeout(() => {
            reject(new Error('timeout waiting for pong'));
          }, 500);

          ws.addEventListener(
            'message',
            (event) => {
              clearTimeout(t);
              resolve(JSON.parse(event.data as string) as Record<string, unknown>);
            },
            { once: true },
          );

          ws.send(JSON.stringify({ type: 'ping', commandId: cmdId }));
        });
      }),
    );

    // All 10 pings must have received a pong
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(500);

    expect(pingResults).toHaveLength(10);
    for (const pong of pingResults) {
      expect(pong.type).toBe('pong');
      expect(typeof pong.commandId).toBe('string');
      expect(typeof pong.timestamp).toBe('string');
    }

    // Clean up all connections
    for (const { ws } of connections) {
      ws.close();
    }
  });
});
