# Design Document: Phase 5.2 — WebSocket Layer

## Overview

Phase 5.2 adds bidirectional WebSocket communication to AgentHQ, enabling interactive agent control (cancel, pause, resume), multi-user collaboration broadcasts, and subscription-filtered updates.

The WebSocket layer builds on top of the database layer from Phase 5.1, using it for command persistence and status history tracking. The SSE `/events` endpoint remains available for clients that cannot upgrade to WebSocket.

```
Existing:  SSE (unidirectional) → dashboard clients
Phase 5.2: WebSocket (bidirectional) ↔ dashboard clients
           Commands → db layer (Phase 5.1) → status updates
```

**Dependencies:** Requires Phase 5.1 (Database Layer) completed.

---

## Architecture

### Component Diagram

```
┌────────────────────────────────────────────────────────────┐
│                  Bun.serve (monitor.ts)                    │
│                                                            │
│  HTTP Routes              WebSocket Routes                 │
│  ─────────────            ────────────────                 │
│  GET  /events (SSE)       GET /ws (upgrade)                │
└────────────────────────────────┬───────────────────────────┘
                                 │
          ┌──────────────────────▼──────────────────────┐
          │         src/ws/  (WebSocket)                 │
          │  server.ts       — Bun WS upgrade handler    │
          │  protocol.ts     — parse / validate msgs     │
          │  subscriptions.ts— per-client subscriptions  │
          │  commands.ts     — cancel/pause/resume       │
          └──────────────────────┬──────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │   src/db/ (Phase 5.1)   │
                    │  Status updates          │
                    │  Command persistence     │
                    └─────────────────────────┘
```

### Module Structure

```
src/
├── config/
│   └── ws-config.ts          # loadWsConfig() — WS env vars
├── ws/
│   ├── server.ts             # Bun WS upgrade, connection lifecycle
│   ├── protocol.ts           # ClientMessage / ServerMessage types
│   ├── subscriptions.ts      # SubscriptionManager class
│   ├── commands.ts           # CommandHandler class
│   └── broadcaster.ts        # WsBroadcaster — send to subscribed clients
└── routes/
    └── ws.ts                 # register(router) — /ws WebSocket upgrade route
```

---

## Components and Interfaces

### WebSocket Server

**`src/ws/server.ts`** — Handles Bun WebSocket upgrades and connection lifecycle:

```typescript
import type { ServerWebSocket } from 'bun';
import type { SubscriptionManager } from './subscriptions.ts';
import type { CommandHandler } from './commands.ts';
import { parseClientMessage } from './protocol.ts';

export interface WsServerConfig {
  idleTimeout: number;      // seconds
  maxMessageSize: number;   // bytes
}

export class WsServer {
  constructor(
    private config: WsServerConfig,
    private subscriptionMgr: SubscriptionManager,
    private commandHandler: CommandHandler
  ) {}

  upgrade(req: Request): Response | undefined {
    const success = Bun.upgrade(req, {
      data: { clientId: this.generateClientId() }
    });
    return success ? undefined : new Response('WebSocket upgrade failed', { status: 400 });
  }

  open(ws: ServerWebSocket<{ clientId: string }>): void {
    const clientId = ws.data.clientId;
    this.subscriptionMgr.addClient(clientId, ws);
    
    ws.send(JSON.stringify({
      type: 'connected',
      clientId,
      workspaceIds: this.getAvailableWorkspaces()
    }));
  }

  async message(ws: ServerWebSocket<{ clientId: string }>, message: string | Buffer): Promise<void> {
    if (typeof message !== 'string') {
      ws.close(1003, 'Binary messages not supported');
      return;
    }

    if (message.length > this.config.maxMessageSize) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 413,
        message: 'message too large'
      }));
      return;
    }

    try {
      const parsed = JSON.parse(message);
      const clientMsg = parseClientMessage(parsed);
      
      if (!clientMsg.success) {
        ws.send(JSON.stringify({
          type: 'error',
          code: 400,
          message: clientMsg.error
        }));
        return;
      }

      await this.handleClientMessage(ws, clientMsg.value);
    } catch (err) {
      ws.close(1003, 'Invalid JSON');
    }
  }

  close(ws: ServerWebSocket<{ clientId: string }>): void {
    this.subscriptionMgr.removeClient(ws.data.clientId);
  }

  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }

  private async handleClientMessage(ws: ServerWebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({
          type: 'pong',
          commandId: msg.commandId,
          timestamp: new Date().toISOString()
        }));
        break;

      case 'subscribe':
        const sub = this.subscriptionMgr.subscribe(ws.data.clientId, {
          workspaceId: msg.workspaceId,
          chainId: msg.chainId
        });
        ws.send(JSON.stringify({
          type: 'ack',
          commandId: msg.commandId,
          success: true,
          subscriptionId: sub.id
        }));
        break;

      case 'unsubscribe':
        this.subscriptionMgr.unsubscribe(ws.data.clientId, msg.subscriptionId);
        ws.send(JSON.stringify({
          type: 'ack',
          commandId: msg.commandId,
          success: true
        }));
        break;

      case 'cancel-job':
      case 'pause-agent':
      case 'resume-agent':
        const result = await this.commandHandler.handle(msg);
        ws.send(JSON.stringify({
          type: 'ack',
          commandId: msg.commandId,
          success: result.success,
          error: result.error
        }));
        break;
    }
  }
}
```

### Message Protocol

**`src/ws/protocol.ts`** — Message types and validation:

```typescript
export type ClientMessage =
  | { type: 'subscribe';   workspaceId?: string; chainId?: string; commandId: string }
  | { type: 'unsubscribe'; subscriptionId: string;                  commandId: string }
  | { type: 'ping';                                                  commandId: string }
  | { type: 'cancel-job';  jobId: string;         workspaceId: string; commandId: string }
  | { type: 'pause-agent'; sessionHash: string;   workspaceId: string; commandId: string }
  | { type: 'resume-agent';sessionHash: string;   workspaceId: string; commandId: string };

export type ServerMessage =
  | { type: 'connected';   clientId: string; workspaceIds: string[] }
  | { type: 'pong';        commandId: string; timestamp: string }
  | { type: 'ack';         commandId: string; success: boolean; error?: string; subscriptionId?: string }
  | { type: 'update';      event: SSEUpdateEvent }
  | { type: 'user-action'; userId: string; action: string; target: string; timestamp: string }
  | { type: 'status-change'; jobId: string; oldStatus: string; newStatus: string;
      timestamp: string; success: boolean; workspaceId: string }
  | { type: 'command-error'; userId: string; commandId: string; error: string }
  | { type: 'error';       code: number; message: string; commandId?: string };

export interface Result<T> {
  success: boolean;
  value?: T;
  error?: string;
}

export function parseClientMessage(raw: unknown): Result<ClientMessage> {
  if (typeof raw !== 'object' || raw === null) {
    return { success: false, error: 'Message must be an object' };
  }

  const msg = raw as Record<string, unknown>;

  if (typeof msg.type !== 'string') {
    return { success: false, error: 'Missing or invalid type field' };
  }

  if (typeof msg.commandId !== 'string') {
    return { success: false, error: 'Missing or invalid commandId field' };
  }

  // Validate commandId format: cmd_${timestamp}_${random}
  if (!/^cmd_\d+_[a-z0-9]+$/.test(msg.commandId)) {
    return { success: false, error: 'Invalid commandId format' };
  }

  // Type-specific validation
  switch (msg.type) {
    case 'subscribe':
      if (msg.workspaceId && typeof msg.workspaceId !== 'string') {
        return { success: false, error: 'Invalid workspaceId field' };
      }
      if (msg.chainId && typeof msg.chainId !== 'string') {
        return { success: false, error: 'Invalid chainId field' };
      }
      break;

    case 'cancel-job':
      if (typeof msg.jobId !== 'string' || typeof msg.workspaceId !== 'string') {
        return { success: false, error: 'Missing jobId or workspaceId' };
      }
      break;

    case 'pause-agent':
    case 'resume-agent':
      if (typeof msg.sessionHash !== 'string' || typeof msg.workspaceId !== 'string') {
        return { success: false, error: 'Missing sessionHash or workspaceId' };
      }
      break;
  }

  return { success: true, value: msg as ClientMessage };
}
```

### Subscription Manager

**`src/ws/subscriptions.ts`** — Manages per-client subscriptions:

```typescript
import type { ServerWebSocket } from 'bun';

export interface Subscription {
  id: string;
  clientId: string;
  workspaceId?: string;
  chainId?: string;
  createdAt: string;
}

export interface WsClient {
  id: string;
  subscriptions: Set<string>;  // subscription IDs
  lastActivity: number;         // Date.now()
  ws: ServerWebSocket<unknown>;
}

export class SubscriptionManager {
  private clients = new Map<string, WsClient>();
  private subscriptions = new Map<string, Subscription>();

  addClient(clientId: string, ws: ServerWebSocket<unknown>): void {
    this.clients.set(clientId, {
      id: clientId,
      subscriptions: new Set(),
      lastActivity: Date.now(),
      ws
    });
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove all subscriptions for this client
    for (const subId of client.subscriptions) {
      this.subscriptions.delete(subId);
    }

    this.clients.delete(clientId);
  }

  subscribe(clientId: string, filter: { workspaceId?: string; chainId?: string }): Subscription {
    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client ${clientId} not found`);
    }

    const subId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const subscription: Subscription = {
      id: subId,
      clientId,
      workspaceId: filter.workspaceId,
      chainId: filter.chainId,
      createdAt: new Date().toISOString()
    };

    this.subscriptions.set(subId, subscription);
    client.subscriptions.add(subId);
    client.lastActivity = Date.now();

    return subscription;
  }

  unsubscribe(clientId: string, subscriptionId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    client.subscriptions.delete(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    client.lastActivity = Date.now();
  }

  getInterestedClients(event: { workspaceId: string; chainId?: string }): WsClient[] {
    const interested: WsClient[] = [];

    for (const sub of this.subscriptions.values()) {
      // Match workspace and chain
      if (sub.workspaceId && sub.workspaceId !== event.workspaceId) {
        continue;
      }

      if (sub.chainId && sub.chainId !== event.chainId) {
        continue;
      }

      const client = this.clients.get(sub.clientId);
      if (client) {
        interested.push(client);
      }
    }

    return interested;
  }
}
```

### Command Handler

**`src/ws/commands.ts`** — Executes agent control commands:

```typescript
import type { DbAdapter } from '../db/adapter.ts';
import type { ClientMessage } from './protocol.ts';

export interface CommandResult {
  success: boolean;
  error?: string;
}

export class CommandHandler {
  constructor(private db: DbAdapter) {}

  async handle(cmd: ClientMessage): Promise<CommandResult> {
    switch (cmd.type) {
      case 'cancel-job':
        return this.handleCancelJob(cmd);
      case 'pause-agent':
        return this.handlePauseAgent(cmd);
      case 'resume-agent':
        return this.handleResumeAgent(cmd);
      default:
        return { success: false, error: 'Unknown command type' };
    }
  }

  private async handleCancelJob(cmd: Extract<ClientMessage, { type: 'cancel-job' }>): Promise<CommandResult> {
    // Query job from database
    const result = await this.db.query<{ id: string; workspace_id: string; status: string }>(
      'SELECT id, workspace_id, status FROM jobs WHERE id = ?',
      [cmd.jobId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'not found' };
    }

    const job = result.rows[0];

    // Validate workspace match
    if (job.workspace_id !== cmd.workspaceId) {
      return { success: false, error: 'workspace mismatch' };
    }

    // Update job status to error
    await this.db.transaction(async (tx) => {
      await tx.execute(
        `UPDATE jobs SET status = 'error', agent_done = ?
         WHERE id = ?`,
        [new Date().toISOString(), cmd.jobId]
      );

      // Record status change
      await tx.execute(
        `INSERT INTO job_status_history (job_id, workspace_id, old_status, new_status, reason)
         VALUES (?, ?, ?, ?, ?)`,
        [cmd.jobId, cmd.workspaceId, job.status, 'error', 'cancelled by user']
      );
    });

    // TODO: Terminate agent process (implementation depends on agent architecture)

    return { success: true };
  }

  private async handlePauseAgent(cmd: Extract<ClientMessage, { type: 'pause-agent' }>): Promise<CommandResult> {
    // Query session from database
    const result = await this.db.query<{ chain_id: string; workflow_hash: string; status: string }>(
      `SELECT chain_id, workflow_hash, status FROM sessions
       WHERE workflow_hash = ? AND workspace_id = ?`,
      [cmd.sessionHash, cmd.workspaceId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'not found' };
    }

    const session = result.rows[0];

    if (session.status !== 'running') {
      return {
        success: false,
        error: `invalid state transition: cannot pause from ${session.status}`
      };
    }

    // Update session status
    await this.db.execute(
      `UPDATE sessions SET status = 'paused' WHERE workflow_hash = ? AND workspace_id = ?`,
      [cmd.sessionHash, cmd.workspaceId]
    );

    // TODO: Suspend agent execution

    return { success: true };
  }

  private async handleResumeAgent(cmd: Extract<ClientMessage, { type: 'resume-agent' }>): Promise<CommandResult> {
    // Similar to pauseAgent, but checks for 'paused' status and transitions to 'running'
    const result = await this.db.query<{ chain_id: string; workflow_hash: string; status: string }>(
      `SELECT chain_id, workflow_hash, status FROM sessions
       WHERE workflow_hash = ? AND workspace_id = ?`,
      [cmd.sessionHash, cmd.workspaceId]
    );

    if (result.rows.length === 0) {
      return { success: false, error: 'not found' };
    }

    const session = result.rows[0];

    if (session.status !== 'paused') {
      return {
        success: false,
        error: `invalid state transition: cannot resume from ${session.status}`
      };
    }

    await this.db.execute(
      `UPDATE sessions SET status = 'running' WHERE workflow_hash = ? AND workspace_id = ?`,
      [cmd.sessionHash, cmd.workspaceId]
    );

    // TODO: Resume agent execution

    return { success: true };
  }
}
```

### WebSocket Broadcaster

**`src/ws/broadcaster.ts`** — Sends updates to subscribed clients:

```typescript
import type { SubscriptionManager } from './subscriptions.ts';
import type { ServerMessage } from './protocol.ts';

export class WsBroadcaster {
  constructor(private subscriptionMgr: SubscriptionManager) {}

  broadcastStatusChange(event: {
    jobId: string;
    workspaceId: string;
    chainId?: string;
    oldStatus: string;
    newStatus: string;
    success: boolean;
  }): void {
    const clients = this.subscriptionMgr.getInterestedClients({
      workspaceId: event.workspaceId,
      chainId: event.chainId
    });

    const message: ServerMessage = {
      type: 'status-change',
      jobId: event.jobId,
      oldStatus: event.oldStatus,
      newStatus: event.newStatus,
      timestamp: new Date().toISOString(),
      success: event.success,
      workspaceId: event.workspaceId
    };

    for (const client of clients) {
      client.ws.send(JSON.stringify(message));
    }
  }

  broadcastUserAction(event: {
    userId: string;
    action: string;
    target: string;
    workspaceId: string;
  }): void {
    const clients = this.subscriptionMgr.getInterestedClients({
      workspaceId: event.workspaceId
    });

    const message: ServerMessage = {
      type: 'user-action',
      userId: event.userId,
      action: event.action,
      target: event.target,
      timestamp: new Date().toISOString()
    };

    for (const client of clients) {
      client.ws.send(JSON.stringify(message));
    }
  }
}
```

---

## Configuration

```typescript
// src/config/ws-config.ts

export interface WsConfig {
  enabled: boolean;        // WS_ENABLED (default: true)
  idleTimeout: number;     // WS_IDLE_TIMEOUT seconds (default: 30)
  maxMessageSize: number;  // WS_MAX_MESSAGE_SIZE bytes (default: 1MB)
}

export function loadWsConfig(env: Record<string, string | undefined>): WsConfig {
  const enabled = env.WS_ENABLED?.toLowerCase();
  const idleTimeout = parseInt(env.WS_IDLE_TIMEOUT || '30', 10);
  const maxMessageSize = parseInt(env.WS_MAX_MESSAGE_SIZE || '1048576', 10);

  if (idleTimeout < 10 || idleTimeout > 300) {
    console.warn(`WS_IDLE_TIMEOUT ${idleTimeout} out of range [10, 300], using default 30`);
  }

  if (maxMessageSize < 1024 || maxMessageSize > 10485760) {
    console.warn(`WS_MAX_MESSAGE_SIZE ${maxMessageSize} out of range [1KB, 10MB], using default 1MB`);
  }

  return {
    enabled: enabled !== 'false',
    idleTimeout: Math.max(10, Math.min(300, idleTimeout)),
    maxMessageSize: Math.max(1024, Math.min(10485760, maxMessageSize))
  };
}
```

---

## Job Status State Machine

Valid job status transitions (enforced by `CommandHandler`):

```
         ┌─────────┐
    ────>│ running │<────────────┐
         └─────────┘             │
              │                  │
              │ (normal          │ (resume)
              │  completion)     │
              │                  │
              ▼                  │
         ┌─────────┐        ┌────────┐
         │  done   │        │ paused │
         └─────────┘        └────────┘
              │                  ▲
              │                  │
              │                  │ (pause)
              ▼                  │
         ┌─────────┐             │
         │reported │─────────────┘
         └─────────┘
              
         ┌─────────┐
         │  error  │<──── (cancel, failure)
         └─────────┘

Blocked transitions (return validation error):
  - done → running
  - error → running
  - reported → running (unless resume from paused)
```

---

## Integration with Dashboard

### Client-Side WebSocket Setup

```typescript
// Dashboard: src/dashboard/ws-client.ts

class WsClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;

  connect(): void {
    try {
      this.ws = new WebSocket('ws://localhost:3333/ws');

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.reconnectAttempts = 0;
      };

      this.ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        this.handleServerMessage(msg);
      };

      this.ws.onclose = () => {
        console.log('WebSocket closed, falling back to SSE');
        this.fallbackToSSE();
      };

      this.ws.onerror = (err) => {
        console.error('WebSocket error:', err);
      };
    } catch (err) {
      console.error('WebSocket constructor failed, falling back to SSE');
      this.fallbackToSSE();
    }
  }

  sendCommand(command: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
    }
  }

  private fallbackToSSE(): void {
    const eventSource = new EventSource('/events');
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleServerMessage({ type: 'update', event: data });
    };
  }

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'connected':
        console.log(`Connected as ${msg.clientId}`);
        // Subscribe to workspace
        this.sendCommand({
          type: 'subscribe',
          workspaceId: 'default',
          commandId: this.generateCommandId()
        });
        break;

      case 'status-change':
        // Update UI
        console.log(`Job ${msg.jobId}: ${msg.oldStatus} → ${msg.newStatus}`);
        break;

      case 'ack':
        console.log(`Command ${msg.commandId}: ${msg.success ? 'success' : 'failed'}`);
        break;
    }
  }

  private generateCommandId(): string {
    return `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  }
}
```

---

## Data Models

### WebSocket Message Types

All messages are defined in `src/ws/protocol.ts`:

```typescript
export type ClientMessage =
  | { type: 'subscribe';   workspaceId?: string; chainId?: string; commandId: string }
  | { type: 'unsubscribe'; subscriptionId: string;                  commandId: string }
  | { type: 'ping';                                                  commandId: string }
  | { type: 'cancel-job';  jobId: string;         workspaceId: string; commandId: string }
  | { type: 'pause-agent'; sessionHash: string;   workspaceId: string; commandId: string }
  | { type: 'resume-agent';sessionHash: string;   workspaceId: string; commandId: string };

export type ServerMessage =
  | { type: 'connected';   clientId: string; workspaceIds: string[] }
  | { type: 'pong';        commandId: string; timestamp: string }
  | { type: 'ack';         commandId: string; success: boolean; error?: string; subscriptionId?: string }
  | { type: 'update';      event: SSEUpdateEvent }
  | { type: 'user-action'; userId: string; action: string; target: string; timestamp: string }
  | { type: 'status-change'; jobId: string; oldStatus: string; newStatus: string;
      timestamp: string; success: boolean; workspaceId: string }
  | { type: 'command-error'; userId: string; commandId: string; error: string }
  | { type: 'error';       code: number; message: string; commandId?: string };
```

### Subscription Model

```typescript
export interface Subscription {
  id: string;           // subscription ID (format: sub_${timestamp}_${random})
  clientId: string;
  workspaceId?: string; // optional workspace filter
  chainId?: string;     // optional chain filter
  createdAt: string;    // ISO 8601
}

export interface WsClient {
  id: string;                  // unique client ID (format: client_${timestamp}_${random})
  subscriptions: Set<string>;  // subscription IDs
  lastActivity: number;        // Date.now() — used for idle timeout
  ws: ServerWebSocket<unknown>;
}
```

---

## Correctness Properties

### Invariants

1. **Command ID Uniqueness** — All command IDs MUST follow format `cmd_${timestamp}_${random}` where timestamp is Unix ms and random is alphanumeric
2. **Subscription Cleanup** — When a client disconnects, ALL subscriptions for that client MUST be removed
3. **Acknowledgement Order** — Commands MUST receive acknowledgements in the order they were received
4. **Workspace Validation** — All commands MUST validate workspace ID matches the target entity's workspace before execution

### Round-Trip Properties

1. **Message Serialization** — For all valid messages M: `parse(stringify(M)) === M`
2. **Subscribe/Unsubscribe Idempotence** — Subscribing to same workspace twice MUST return `already_subscribed`; unsubscribing non-existent subscription MUST return `not_subscribed`

### Bounded Operations

1. **Ping/Pong Latency** — Pong responses MUST be sent within 100ms of ping receipt
2. **Command Processing** — Job cancellation MUST complete within 5 seconds; pause/resume within 2 seconds
3. **Broadcast Latency** — Status change broadcasts MUST reach subscribed clients within 2 seconds

---

## Error Handling

### Failure Modes and Recovery

**WebSocket Connection Failure**
- **Detection:** WebSocket constructor throws or connection closes unexpectedly
- **Response:** Client automatically falls back to SSE EventSource
- **Recovery:** Client retries WebSocket connection with exponential backoff (1s, 2s, 4s, max 5 attempts)

**Invalid Message Format**
- **Detection:** JSON.parse fails or message fails schema validation
- **Response:** Send error response with validation details, close connection with code 1003
- **Recovery:** Client must reconnect and send valid messages

**Command Validation Failure**
- **Detection:** Workspace mismatch, job not found, invalid state transition
- **Response:** Send acknowledgement with `success: false` and error details
- **Recovery:** Client should display error to user; no automatic retry

**Database Unavailable During Command**
- **Detection:** Database query/execute throws exception
- **Response:** Send acknowledgement with `success: false, error: "<db_error>"`
- **Recovery:** Command fails; client may retry manually

**Idle Timeout**
- **Detection:** No messages (ping/pong or data) for 60 seconds
- **Response:** Server automatically closes connection
- **Recovery:** Client detects close event, reconnects automatically

---

## Testing Strategy

### Unit Tests
- Message parsing and validation
- Subscription management (add/remove/match)
- Command handler logic (workspace validation, status transitions)

### Integration Tests
- Full WebSocket flow (connect, subscribe, command, disconnect)
- Concurrent connections (≥10 clients)
- Graceful fallback to SSE

### Property-Based Tests
- Round-trip serialization: `parse(stringify(M)) === M` for all valid messages
- Subscription filtering correctness

---

## Error Handling Strategy

1. **Invalid JSON** → Close connection with code 1003
2. **Message too large** → Send error response, keep connection open
3. **Unknown command** → Send ack with `success: false`
4. **Command validation failure** → Send ack with error details
5. **Database unavailable** → Command fails, log error, return error ack
6. **Idle timeout (30s)** → Close connection automatically

---

## Migration Path

1. **Fresh install** — WebSocket enabled by default, SSE still available
2. **Upgrade from Phase 5.1** — Dashboard detects WebSocket support and upgrades automatically
3. **Fallback** — If WebSocket fails, dashboard falls back to SSE seamlessly
