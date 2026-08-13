/**
 * WebSocket server.
 *
 * Handles Bun WebSocket upgrade and connection lifecycle: open, message,
 * close. Delegates message parsing to {@link parseClientMessage}, command
 * execution to {@link CommandHandler}, and subscription tracking to
 * {@link SubscriptionManager}.
 *
 * All connection events (connect / disconnect) and user commands are logged
 * as structured JSON for observability (Requirement 9.1, 9.2).
 */

import type { ServerWebSocket, Server } from 'bun';
import type { SubscriptionManager } from './subscriptions.js';
import type { CommandHandler } from './commands.js';
import type { ClientMessage } from './protocol.js';
import { parseClientMessage } from './protocol.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Runtime configuration for {@link WsServer}.
 *
 * Values are loaded from env by `loadWsConfig()` and forwarded here by the
 * monitor bootstrap.
 */
export type WsServerConfig = {
  /** Maximum idle duration in seconds before Bun closes the connection. */
  idleTimeout: number;
  /** Maximum allowed message payload size in bytes (messages exceeding this are rejected). */
  maxMessageSize: number;
};

// ---------------------------------------------------------------------------
// WsServer
// ---------------------------------------------------------------------------

/**
 * Manages the full lifecycle of Bun WebSocket connections.
 *
 * Methods `open`, `message`, and `close` are designed to be wired directly
 * into the `websocket` option of `Bun.serve`:
 *
 * ```ts
 * Bun.serve({
 *   websocket: {
 *     open:    ws => wsServer.open(ws),
 *     message: (ws, msg) => wsServer.message(ws, msg),
 *     close:   ws => wsServer.close(ws),
 *     idleTimeout: config.idleTimeout,
 *   },
 * });
 * ```
 */
export class WsServer {
  /**
   * The Bun `Server` instance, injected via {@link setServer} after `Bun.serve()` starts.
   * Required by {@link upgrade}; if not set, `upgrade` returns HTTP 503.
   */
  private server: Server<{ clientId: string }> | undefined;

  constructor(
    private readonly config: WsServerConfig,
    private readonly subscriptionMgr: SubscriptionManager,
    private readonly commandHandler: CommandHandler,
  ) {}

  /**
   * Bind the Bun `Server` instance so that {@link upgrade} can call
   * `server.upgrade()`. Must be called after `Bun.serve()` returns.
   *
   * @param server The live Bun server handle
   */
  setServer(server: Server<{ clientId: string }>): void {
    this.server = server;
  }

  // -------------------------------------------------------------------------
  // HTTP → WebSocket upgrade
  // -------------------------------------------------------------------------

  /**
   * Attempt to upgrade an HTTP request to a WebSocket connection.
   *
   * Assigns a new unique `clientId` to the connection via the Bun server's
   * `upgrade()` call. Requires {@link setServer} to have been called first.
   *
   * @param req Incoming HTTP upgrade request
   * @returns `undefined` on successful upgrade; `Response` with HTTP 400 on failure,
   *          or HTTP 503 if the server reference has not been set yet
   */
  upgrade(req: Request): Response | undefined {
    if (this.server === undefined) {
      return new Response('WebSocket server not initialised', { status: 503 });
    }

    const success = this.server.upgrade(req, {
      data: { clientId: this.generateClientId() },
    });

    return success ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Called by Bun when a WebSocket connection is established.
   *
   * Registers the client with {@link SubscriptionManager}, sends the initial
   * `connected` message, and logs the connection event.
   *
   * @param ws The newly opened WebSocket with `{ clientId }` in its data
   */
  open(ws: ServerWebSocket<{ clientId: string }>): void {
    const { clientId } = ws.data;

    this.subscriptionMgr.addClient(clientId, ws);

    ws.send(
      JSON.stringify({
        type: 'connected',
        clientId,
        workspaceIds: [] as string[],
      }),
    );

    console.log(
      JSON.stringify({
        level: 'INFO',
        event_type: 'connect',
        client_id: clientId,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  /**
   * Called by Bun when a message arrives on an open WebSocket connection.
   *
   * Processing pipeline:
   * 1. Reject binary frames (close 1003)
   * 2. Reject oversized messages (error 413, connection kept open)
   * 3. Parse JSON; close 1003 on parse failure
   * 4. Validate message structure via `parseClientMessage`
   * 5. Dispatch to `handleClientMessage`
   *
   * @param ws  The receiving WebSocket
   * @param msg Raw message — always a string for text frames; Buffer for binary frames
   */
  async message(
    ws: ServerWebSocket<{ clientId: string }>,
    msg: string | Buffer,
  ): Promise<void> {
    if (typeof msg !== 'string') {
      ws.close(1003, 'Binary messages not supported');
      return;
    }

    if (msg.length > this.config.maxMessageSize) {
      ws.send(
        JSON.stringify({ type: 'error', code: 413, message: 'message too large' }),
      );
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(msg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`WebSocket message parse failed: ${message}`);
      ws.close(1003, 'Invalid JSON');
      return;
    }

    const result = parseClientMessage(parsed);

    if (!result.success) {
      ws.send(
        JSON.stringify({ type: 'error', code: 400, message: result.error }),
      );
      return;
    }

    // result.value is defined when success === true (guaranteed by parseClientMessage)
    await this.handleClientMessage(ws, result.value as ClientMessage);
  }

  /**
   * Called by Bun when a WebSocket connection closes.
   *
   * Attempts to remove the client from {@link SubscriptionManager}; logs any
   * cleanup errors rather than propagating them, then logs the disconnect event.
   *
   * @param ws The closed WebSocket
   */
  close(ws: ServerWebSocket<{ clientId: string }>): void {
    const { clientId } = ws.data;

    try {
      this.subscriptionMgr.removeClient(clientId);
    } catch (err) {
      console.error(
        JSON.stringify({
          level: 'ERROR',
          event_type: 'cleanup_error',
          client_id: clientId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }

    console.log(
      JSON.stringify({
        level: 'INFO',
        event_type: 'disconnect',
        client_id: clientId,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  /**
   * Route a validated {@link ClientMessage} to the appropriate handler.
   *
   * @param ws  The originating WebSocket
   * @param msg Validated, typed client message
   */
  async handleClientMessage(
    ws: ServerWebSocket<{ clientId: string }>,
    msg: ClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      // ------------------------------------------------------------------
      case 'ping': {
        ws.send(
          JSON.stringify({
            type: 'pong',
            commandId: msg.commandId,
            timestamp: new Date().toISOString(),
          }),
        );
        break;
      }

      // ------------------------------------------------------------------
      case 'subscribe': {
        const sub = this.subscriptionMgr.subscribe(ws.data.clientId, {
          workspaceId: msg.workspaceId,
          chainId: msg.chainId,
        });

        ws.send(
          JSON.stringify({
            type: 'ack',
            commandId: msg.commandId,
            success: true,
            subscriptionId: sub.id,
          }),
        );
        break;
      }

      // ------------------------------------------------------------------
      case 'unsubscribe': {
        this.subscriptionMgr.unsubscribe(ws.data.clientId, msg.subscriptionId);

        ws.send(
          JSON.stringify({
            type: 'ack',
            commandId: msg.commandId,
            success: true,
          }),
        );
        break;
      }

      // ------------------------------------------------------------------
      case 'cancel-job':
      case 'pause-agent':
      case 'resume-agent': {
        const startMs = Date.now();
        const result = await this.commandHandler.handle(msg);
        const durationMs = Date.now() - startMs;

        ws.send(
          JSON.stringify({
            type: 'ack',
            commandId: msg.commandId,
            success: result.success,
            error: result.error,
          }),
        );

        const targetEntityId =
          msg.type === 'cancel-job' ? msg.jobId : msg.sessionHash;

        console.log(
          JSON.stringify({
            level: 'INFO',
            user_id: ws.data.clientId,
            command_type: msg.type,
            target_entity_id: targetEntityId,
            execution_result: result.success,
            duration_ms: durationMs,
          }),
        );
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Generate a unique client identifier.
   *
   * Format: `client_${Date.now()}_${random alphanum}`
   */
  generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}
