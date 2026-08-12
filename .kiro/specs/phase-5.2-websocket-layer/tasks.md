# Implementation Plan: Phase 5.2 — WebSocket Layer

## Skill Activation — REQUIRED before every task

**Call `disclose_context` for these skills before writing any code or tests:**

| Always | `accelint-ts-best-practices`, `accelint-ts-testing` |
|--------|------------------------------------------------------|
| + DB / backend / routes | `error-handling-patterns` |
| + dashboard / UI | `agenthq-dashboard` |
| + performance / query timing | `accelint-ts-performance` |
| + security / validation / SQL | `best-practices` |
| + JSDoc / comments | `accelint-ts-documentation` |
| + refactoring / coupling | `improve-codebase-architecture` |

These skills do NOT activate automatically during spec task execution.
`disclose_context` must be called explicitly at the start of each task.

---

## Overview

Implementation plan for the Phase 5.2 WebSocket layer. This phase adds bidirectional
WebSocket communication to AgentHQ, enabling interactive agent control (cancel, pause,
resume), multi-user collaboration broadcasts, and subscription-filtered real-time updates.

Builds on Phase 5.1 (`DbAdapter`, migration runner, row types). The SSE `/events`
endpoint remains unchanged — this phase adds WebSocket alongside it.

All code is TypeScript targeting Bun. Tests use `bun test` + `fast-check`.

---

## Tasks

- [x] 1. WebSocket configuration — `src/config/ws-config.ts` and `test/config/ws-config.test.ts`
  - [x] 1.1 Implement `WsConfig` interface and `loadWsConfig(env)` in `src/config/ws-config.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")`, `disclose_context("accelint-ts-testing")`, and `disclose_context("error-handling-patterns")` before writing any code
    - Export `WsConfig` interface: `{ enabled: boolean; idleTimeout: number; maxMessageSize: number }`
    - Parse `WS_ENABLED` (default `true`; any value other than the string `"false"` is truthy)
    - Parse `WS_IDLE_TIMEOUT` (integer seconds, clamp to `[10, 300]`, default `30`)
    - Parse `WS_MAX_MESSAGE_SIZE` (integer bytes, clamp to `[1024, 10485760]`, default `1048576`)
    - Log a warning in format `"Configuration error: WS_IDLE_TIMEOUT: <specific_issue>"` for each out-of-range value before clamping; use clamped value, do not throw
    - Log the same warning format for `WS_MAX_MESSAGE_SIZE` out-of-range
    - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - [x] 1.2 Add WebSocket entries to `.env.example`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` before editing
    - Append a `# WebSocket Configuration` block after the existing `# Database Configuration` block
    - Add commented entries: `WS_ENABLED=true`, `WS_IDLE_TIMEOUT=30`, `WS_MAX_MESSAGE_SIZE=1048576`
    - Include a short comment above each entry describing valid range / default
    - _Requirements: 6.1, 6.2, 6.3_
  - [x] 1.3 Write unit tests for `loadWsConfig()` in `test/config/ws-config.test.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - Test: valid defaults (`{}` env) returns `{ enabled: true, idleTimeout: 30, maxMessageSize: 1048576 }`
    - Test: `WS_ENABLED="false"` returns `enabled: false`; any other string returns `enabled: true`
    - Test: `WS_IDLE_TIMEOUT="5"` (below min) clamps to 10 and logs warning
    - Test: `WS_IDLE_TIMEOUT="999"` (above max) clamps to 300 and logs warning
    - Test: `WS_IDLE_TIMEOUT="10"` and `"300"` are accepted without warning (boundary values)
    - Test: `WS_MAX_MESSAGE_SIZE="512"` clamps to 1024 with warning
    - Test: `WS_MAX_MESSAGE_SIZE="20971520"` clamps to 10485760 with warning
    - Use `it('should ...')` sentence format for all test descriptions
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 11.1_

- [x] 2. Message protocol — `src/ws/protocol.ts` and `test/ws/protocol.test.ts`
  - [x] 2.1 Implement `ClientMessage`, `ServerMessage`, `Result<T>`, and `parseClientMessage()` in `src/ws/protocol.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")`, `disclose_context("accelint-ts-testing")`, and `disclose_context("error-handling-patterns")` before writing any code
    - Export `ClientMessage` discriminated union (six variants: `subscribe`, `unsubscribe`, `ping`, `cancel-job`, `pause-agent`, `resume-agent`); every variant carries `commandId: string`
    - Export `ServerMessage` discriminated union (eight variants: `connected`, `pong`, `ack`, `update`, `user-action`, `status-change`, `command-error`, `error`)
    - Export `Result<T>` interface: `{ success: boolean; value?: T; error?: string }`
    - Export `parseClientMessage(raw: unknown): Result<ClientMessage>`:
      - Reject non-object / null with `{ success: false, error: 'Message must be an object' }`
      - Reject missing or non-string `type` with error `'Missing or invalid type field'`
      - Reject missing or non-string `commandId` with error `'Missing or invalid commandId field'`
      - Reject `commandId` not matching `/^cmd_\d+_[a-z0-9]+$/` with error `'Invalid commandId format'`
      - For `cancel-job`: require `jobId: string` and `workspaceId: string`; missing either → error `'Missing jobId or workspaceId'`
      - For `pause-agent` / `resume-agent`: require `sessionHash: string` and `workspaceId: string`; missing either → error `'Missing sessionHash or workspaceId'`
      - For `unsubscribe`: require `subscriptionId: string`
      - For `subscribe`: `workspaceId` and `chainId` are optional but must be `string` if present
      - For `ping`: no additional fields required
      - Unknown `type` values: return `{ success: false, error: 'Unknown message type' }`
    - Do NOT import `bun` types in this file — keep it runtime-agnostic
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 8.1, 11.1_
  - [x] 2.2 Write unit tests for `parseClientMessage()` in `test/ws/protocol.test.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - Test each valid `ClientMessage` type parses successfully and returns the original value
    - Test: `null` rejected; non-object (string, number) rejected
    - Test: missing `commandId` → `success: false`
    - Test: `commandId` without `cmd_` prefix → `success: false`
    - Test: `commandId` with uppercase letters in random part → `success: false`
    - Test: `cancel-job` missing `jobId` → `success: false`; missing `workspaceId` → `success: false`
    - Test: `pause-agent` missing `sessionHash` → `success: false`
    - Test: unknown `type` value → `success: false`
    - Test: `subscribe` with no optional fields → `success: true`
    - _Requirements: 2.3, 2.4, 11.1_
  - [x] 2.3 Write property-based round-trip test for message serialization in `test/ws/protocol.test.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - **Property 1: Message serialization round-trip**
    - Use `fc.record` / `fc.oneof` from `fast-check` to generate arbitrary valid `ClientMessage` instances covering all six variants
    - Assert: `parseClientMessage(JSON.parse(JSON.stringify(msg))).value` deep-equals original `msg` for all generated values
    - Minimum 100 iterations via `fc.assert`
    - **Validates: Requirements 1.8, 11.1**
    - _Requirements: 1.8, 11.1_

- [x] 3. Subscription manager — `src/ws/subscriptions.ts` and `test/ws/subscriptions.test.ts`
  - [x] 3.1 Implement `SubscriptionManager` in `src/ws/subscriptions.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - Export `Subscription` interface: `{ id: string; clientId: string; workspaceId?: string; chainId?: string; createdAt: string }`
    - Export `WsClient` interface: `{ id: string; subscriptions: Set<string>; lastActivity: number; ws: ServerWebSocket<unknown> }`
    - Use `import type { ServerWebSocket } from 'bun'`
    - Export `SubscriptionManager` class with private `clients: Map<string, WsClient>` and `subscriptions: Map<string, Subscription>`
    - `addClient(clientId, ws)`: adds client entry with empty subscription set and `lastActivity = Date.now()`
    - `removeClient(clientId)`: deletes all subscriptions in client's set from `this.subscriptions`, then deletes client
    - `subscribe(clientId, filter)`: checks for duplicate (same `workspaceId` + `chainId`); if duplicate exists returns `{ ...existingSub, status: 'already_subscribed' }`; otherwise creates new sub with id `sub_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`, adds to maps, updates `lastActivity`, returns subscription
    - `unsubscribe(clientId, subscriptionId)`: if sub does not exist returns `{ success: true, status: 'not_subscribed' }`; otherwise removes from both maps and returns `{ success: true }`
    - `getInterestedClients(event: { workspaceId: string; chainId?: string }): WsClient[]`: iterates all subscriptions; skip sub if `sub.workspaceId` is set and doesn't match `event.workspaceId`; skip sub if `sub.chainId` is set and doesn't match `event.chainId`; return unique clients (deduplicate by clientId)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_
  - [x] 3.2 Write unit tests for `SubscriptionManager` in `test/ws/subscriptions.test.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - Use a minimal mock for `ServerWebSocket`: `{ send: () => {}, close: () => {} } as unknown as ServerWebSocket<unknown>`
    - Test: `addClient` then `removeClient` leaves no subscriptions or client entries
    - Test: `subscribe` returns a subscription with valid `id` and `createdAt`
    - Test: duplicate `subscribe` (same workspaceId + chainId) returns existing sub with `status: 'already_subscribed'` and does not create a second entry
    - Test: `unsubscribe` with existing subId removes it; subsequent `getInterestedClients` excludes that client
    - Test: `unsubscribe` with non-existent subId returns `{ success: true, status: 'not_subscribed' }` without throwing
    - Test: `getInterestedClients` with workspaceId filter returns only clients subscribed to that workspace
    - Test: `getInterestedClients` with chainId filter returns only clients subscribed to that chain
    - Test: `getInterestedClients` with both filters applies both (AND semantics)
    - Test: `removeClient` cleans up all subscriptions — `getInterestedClients` returns empty array afterwards
    - Test: `getInterestedClients` deduplicates — client with two matching subscriptions appears only once
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 11.2_

- [x] 4. Command handler — `src/ws/commands.ts` and `test/ws/commands.test.ts`
  - [x] 4.1 Implement `CommandHandler` in `src/ws/commands.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")`, `disclose_context("accelint-ts-testing")`, `disclose_context("error-handling-patterns")`, and `disclose_context("best-practices")` before writing any code
    - Export `CommandResult` interface: `{ success: boolean; error?: string }`
    - Export `CommandHandler` class; constructor takes `db: DbAdapter` (import from `'../db/adapter.js'`)
    - `handle(cmd: ClientMessage): Promise<CommandResult>` — dispatches on `cmd.type`; returns `{ success: false, error: 'Unknown command type' }` for non-command message types
    - `handleCancelJob`:
      - Query `SELECT id, workspace_id, status FROM jobs WHERE id = ?` with `[cmd.jobId]`
      - Return `{ success: false, error: 'not found' }` if no rows
      - Return `{ success: false, error: 'workspace mismatch' }` if `job.workspace_id !== cmd.workspaceId`
      - In a single `db.transaction`: `UPDATE jobs SET status = 'error', agent_done = ? WHERE id = ?` (ISO timestamp), then `INSERT INTO job_status_history (job_id, workspace_id, old_status, new_status, reason) VALUES (?, ?, ?, ?, ?)` with reason `'cancelled by user'`
      - Return `{ success: true }` on completion
    - `handlePauseAgent`:
      - Query `SELECT chain_id, workflow_hash, status FROM sessions WHERE workflow_hash = ? AND workspace_id = ?`
      - Return `{ success: false, error: 'not found' }` if no rows
      - Return `{ success: false, error: 'invalid state transition: cannot pause from <session.status>' }` if `session.status !== 'running'`
      - `UPDATE sessions SET status = 'paused' WHERE workflow_hash = ? AND workspace_id = ?`
      - Return `{ success: true }`
    - `handleResumeAgent`:
      - Same query as pause, same not-found check
      - Return `{ success: false, error: 'invalid state transition: cannot resume from <session.status>' }` if `session.status !== 'paused'`
      - `UPDATE sessions SET status = 'running' WHERE workflow_hash = ? AND workspace_id = ?`
      - Return `{ success: true }`
    - All SQL uses parameterized queries — no string interpolation of external input
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 9.2_
  - [x] 4.2 Write unit tests for `CommandHandler` using an in-memory SQLite mock in `test/ws/commands.test.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - Construct a lightweight `DbAdapter` stub using `SQLiteAdapter` with an in-memory DB (`:memory:`) and the two DDL migrations applied, or use a plain object stub with jest-style spy functions
    - Test: `cancel-job` on existing job with matching workspace → `success: true`; job row has `status = 'error'`; `job_status_history` has one row with `reason = 'cancelled by user'`
    - Test: `cancel-job` on non-existent jobId → `{ success: false, error: 'not found' }`
    - Test: `cancel-job` with wrong `workspaceId` → `{ success: false, error: 'workspace mismatch' }`
    - Test: `pause-agent` on running session → `success: true`; session row has `status = 'paused'`
    - Test: `pause-agent` on non-running session (e.g. `done`) → `success: false`, error contains `'invalid state transition: cannot pause from done'`
    - Test: `resume-agent` on paused session → `success: true`; session row has `status = 'running'`
    - Test: `resume-agent` on non-paused session (e.g. `running`) → `success: false`, error contains `'invalid state transition: cannot resume from running'`
    - Test: DB `query()` throws → `CommandHandler.handle()` propagates the error (let it bubble; callers handle it)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 9.2, 11.2_

- [x] 5. WebSocket broadcaster — `src/ws/broadcaster.ts` and `test/ws/broadcaster.test.ts`
  - [x] 5.1 Implement `WsBroadcaster` in `src/ws/broadcaster.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - Export `WsBroadcaster` class; constructor takes `subscriptionMgr: SubscriptionManager`
    - `broadcastStatusChange(event: { jobId, workspaceId, chainId?, oldStatus, newStatus, success })`:
      - Call `subscriptionMgr.getInterestedClients({ workspaceId, chainId })`
      - Send `{ type: 'status-change', jobId, oldStatus, newStatus, timestamp: new Date().toISOString(), success, workspaceId }` to each client via `client.ws.send(JSON.stringify(msg))`
    - `broadcastUserAction(event: { userId, action, target, workspaceId })`:
      - Call `subscriptionMgr.getInterestedClients({ workspaceId })`
      - Send `{ type: 'user-action', userId, action, target, timestamp: new Date().toISOString() }` to each client
    - `broadcastCommandError(event: { clientId, commandId, error, workspaceId })`:
      - Retrieve the originating `WsClient` from `SubscriptionManager` directly (add a `getClient(clientId): WsClient | undefined` method to `SubscriptionManager`)
      - If client found, send `{ type: 'command-error', userId: clientId, commandId, error }` to that client only
      - If client not found, log a warning and return silently
    - _Requirements: 4.8, 5.1, 5.2, 5.3_
  - [x] 5.2 Add `getClient(clientId)` to `SubscriptionManager` in `src/ws/subscriptions.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` before writing any code
    - Add `getClient(clientId: string): WsClient | undefined` — returns `this.clients.get(clientId)`
    - Update the corresponding test file to cover the new method (one test: returns the client when present, undefined when absent)
    - _Requirements: 5.3_
  - [x] 5.3 Write unit tests for `WsBroadcaster` in `test/ws/broadcaster.test.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - Set up a real `SubscriptionManager` instance with mock `ws` objects (track `send` calls via an array)
    - Test: `broadcastStatusChange` sends only to clients subscribed to the matching workspace
    - Test: `broadcastStatusChange` does NOT send to clients subscribed to a different workspace
    - Test: `broadcastUserAction` sends to all clients subscribed to the matching workspace
    - Test: `broadcastCommandError` sends only to the originating client; other clients receive no message
    - Test: no clients subscribed → no `send` calls (graceful no-op)
    - _Requirements: 4.8, 5.1, 5.2, 5.3, 11.2_

- [ ] 6. Checkpoint — run unit tests and fix failures
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` before proceeding
  - Run `bun test test/config/ws-config.test.ts test/ws/` — all config, protocol, subscriptions, commands, and broadcaster tests must pass
  - Run `node_modules\.bin\tsc.exe --noEmit` and resolve any type errors in `src/ws/` and `src/config/ws-config.ts`

- [ ] 7. WebSocket server — `src/ws/server.ts` and `test/ws/server.test.ts`
  - [ ] 7.1 Implement `WsServer` in `src/ws/server.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")`, `disclose_context("accelint-ts-testing")`, and `disclose_context("error-handling-patterns")` before writing any code
    - Import `import type { ServerWebSocket } from 'bun'`
    - Export `WsServerConfig` interface: `{ idleTimeout: number; maxMessageSize: number }`
    - Export `WsServer` class; constructor takes `(config: WsServerConfig, subscriptionMgr: SubscriptionManager, commandHandler: CommandHandler)`
    - `upgrade(req: Request): Response | undefined`:
      - Call `Bun.upgrade(req, { data: { clientId: this.generateClientId() } })`
      - Return `undefined` on success; return `new Response('WebSocket upgrade failed', { status: 400 })` on failure
    - `open(ws: ServerWebSocket<{ clientId: string }>)`:
      - Call `subscriptionMgr.addClient(ws.data.clientId, ws)`
      - Send `JSON.stringify({ type: 'connected', clientId: ws.data.clientId, workspaceIds: [] })`
      - Log `{ level: 'INFO', event_type: 'connect', client_id: ws.data.clientId, timestamp: new Date().toISOString() }`
    - `message(ws, msg: string | Buffer)`:
      - If `typeof msg !== 'string'` → `ws.close(1003, 'Binary messages not supported')`; return
      - If `msg.length > config.maxMessageSize` → `ws.send(JSON.stringify({ type: 'error', code: 413, message: 'message too large' }))`; return
      - `JSON.parse(msg)` in try/catch; on catch → log `"WebSocket message parse failed: <error.message>"` and `ws.close(1003, 'Invalid JSON')`; return
      - Call `parseClientMessage(parsed)`:
        - On failure: `ws.send(JSON.stringify({ type: 'error', code: 400, message: result.error }))`; return
      - Dispatch to `handleClientMessage(ws, result.value)`
    - `close(ws)`:
      - Call `subscriptionMgr.removeClient(ws.data.clientId)` in try/catch; log any errors
      - Log `{ level: 'INFO', event_type: 'disconnect', client_id: ws.data.clientId, timestamp: new Date().toISOString() }`
    - `handleClientMessage(ws, msg: ClientMessage)`:
      - `ping` → send `{ type: 'pong', commandId: msg.commandId, timestamp: new Date().toISOString() }`
      - `subscribe` → call `subscriptionMgr.subscribe(ws.data.clientId, { workspaceId: msg.workspaceId, chainId: msg.chainId })`; send `{ type: 'ack', commandId: msg.commandId, success: true, subscriptionId: sub.id }`
      - `unsubscribe` → call `subscriptionMgr.unsubscribe(...)`; send `{ type: 'ack', commandId, success: true }`
      - `cancel-job` / `pause-agent` / `resume-agent` → await `commandHandler.handle(msg)`; send `{ type: 'ack', commandId, success: result.success, error: result.error }`; log command with `{ level: 'INFO', user_id: ws.data.clientId, command_type: msg.type, target_entity_id: msg.jobId ?? msg.sessionHash, execution_result: result.success, duration_ms }`
    - `generateClientId()`: returns `` `client_${Date.now()}_${Math.random().toString(36).slice(2, 11)}` ``
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 9.1_
  - [ ] 7.2 Write unit tests for `WsServer` in `test/ws/server.test.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")` and `disclose_context("accelint-ts-testing")` before writing any code
    - Use a mock `ServerWebSocket` (plain object with `send`, `close` spies and a `data` property)
    - Use stub `SubscriptionManager` and `CommandHandler` constructed from their real classes with a mock `DbAdapter`
    - Test: `open(ws)` calls `addClient` and the sent JSON includes `type: 'connected'` and a `clientId`
    - Test: `message` with a `Buffer` → `ws.close` called with code `1003`
    - Test: `message` with string longer than `maxMessageSize` → `ws.send` called with `type: 'error', code: 413`
    - Test: `message` with invalid JSON → `ws.close` called with code `1003`
    - Test: `message` with valid JSON but invalid message structure (bad commandId) → `ws.send` called with `type: 'error', code: 400`
    - Test: `message` with `ping` → `ws.send` called with `type: 'pong'`; response sent synchronously (no await needed for ping path)
    - Test: `message` with `subscribe` → `ws.send` called with `type: 'ack', success: true` and a non-empty `subscriptionId`
    - Test: `message` with `cancel-job` → `commandHandler.handle` called; `ws.send` with `type: 'ack'` matching the result
    - Test: `close(ws)` → `removeClient` called with the client's ID
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.2, 2.3, 2.4, 9.1, 11.2_

- [ ] 8. WebSocket route and monitor integration — `src/routes/ws.ts` and `src/monitor.ts`
  - [ ] 8.1 Implement the `/ws` upgrade route in `src/routes/ws.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")`, `disclose_context("accelint-ts-testing")`, and `disclose_context("error-handling-patterns")` before writing any code
    - Export `register(router: Router, wsServer: WsServer): void`
    - Register `GET /ws` route: call `wsServer.upgrade(req)` and return the result
      - If `wsServer.upgrade` returns `undefined`, the upgrade succeeded (Bun handles the response)
      - If it returns a `Response`, return that response to the client
    - _Requirements: 1.1, 1.2, 7.1_
  - [ ] 8.2 Wire `WsServer` into `src/monitor.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")`, `disclose_context("accelint-ts-testing")`, and `disclose_context("error-handling-patterns")` before writing any code
    - Import `loadWsConfig` from `'./config/ws-config.js'`
    - Import `WsServer`, `SubscriptionManager`, `CommandHandler` from their respective `src/ws/` modules
    - After `loadDbConfig` succeeds, call `loadWsConfig(process.env)` to obtain `wsConfig`
    - If `wsConfig.enabled`:
      - Construct `new SubscriptionManager()`
      - Construct `new CommandHandler(db)` (only when `DB_ENABLED=true`; otherwise pass a stub or skip command handling)
      - Construct `new WsServer({ idleTimeout: wsConfig.idleTimeout, maxMessageSize: wsConfig.maxMessageSize }, subscriptionMgr, commandHandler)`
      - Register `/ws` route via `import { register as registerWs } from './routes/ws.js'` and call `registerWs(router, wsServer)`
      - Pass the WebSocket lifecycle methods to `Bun.serve` via the `websocket` option: `{ open: ws => wsServer.open(ws), message: (ws, msg) => wsServer.message(ws, msg), close: ws => wsServer.close(ws), idleTimeout: wsConfig.idleTimeout }`
    - If `wsConfig.enabled === false`: log `"WebSocket disabled"` and skip all of the above
    - _Requirements: 1.1, 1.2, 6.1, 7.1_

- [ ] 9. Integration tests — `test/integration/ws-server.test.ts`
  - [ ] 9.1 Write integration tests for the full WebSocket flow in `test/integration/ws-server.test.ts`
    - **Skills**: call `disclose_context("accelint-ts-best-practices")`, `disclose_context("accelint-ts-testing")`, and `disclose_context("error-handling-patterns")` before writing any code
    - In `beforeAll`: create an in-memory `SQLiteAdapter`, run migrations via `runMigrations`, construct `SubscriptionManager`, `CommandHandler`, and `WsServer`, then start `Bun.serve` on a random free port with the `websocket` option wired to `WsServer`
    - In `afterAll`: close the Bun server and the `SQLiteAdapter`
    - Helper: `async function connect(port): Promise<WebSocket>` — returns a connected `WebSocket` and waits for the `connected` message
    - Test: connect → receive `{ type: 'connected' }` message containing a non-empty `clientId`
    - Test: send `subscribe` with a workspaceId → receive `{ type: 'ack', success: true }` with a `subscriptionId` matching `/^sub_\d+_[a-z0-9]+$/`
    - Test: send `ping` → receive `{ type: 'pong' }` with matching `commandId`
    - Test: send `cancel-job` for a non-existent jobId → receive `{ type: 'ack', success: false, error: 'not found' }`
    - Test: 10 concurrent connections — each receives a `connected` message; all 10 `ping` messages receive `pong` responses; collect all results and assert all 10 succeed within 500ms total
    - Use `WebSocket` from the Bun global (no import needed in Bun runtime)
    - _Requirements: 1.3, 1.4, 1.7, 3.1, 4.5, 5.4, 11.2, 11.3_

- [ ] 10. Final checkpoint — full test suite and type check
  - **Skills**: call `disclose_context("accelint-ts-best-practices")` before proceeding
  - Run `bun test test/` — all existing tests and all new WebSocket tests must pass
  - Run `node_modules\.bin\tsc.exe --noEmit` — zero type errors

## Notes

- Tasks marked `*` are optional for MVP; all tasks in this plan are core and should be completed
- Subscription IDs use format `` `sub_${Date.now()}_${Math.random().toString(36).slice(2, 11)}` ``
- Client IDs use format `` `client_${Date.now()}_${Math.random().toString(36).slice(2, 11)}` ``
- Command IDs are client-generated and validated as `/^cmd_\d+_[a-z0-9]+$/`
- Use `import type { ServerWebSocket } from 'bun'` throughout — do not polyfill
- `CommandHandler` imports `DbAdapter` from `'../db/adapter.js'` (Phase 5.1)
- All SQL must use parameterized queries — no string interpolation of external input
- Dashboard client-side WebSocket integration (`src/dashboard/ws-client.ts`) is out of scope for this phase
- The SSE `/events` endpoint remains untouched; this phase adds WebSocket alongside it

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2", "3"] },
    { "id": 2, "tasks": ["4", "5"] },
    { "id": 3, "tasks": ["6"] },
    { "id": 4, "tasks": ["7"] },
    { "id": 5, "tasks": ["8"] },
    { "id": 6, "tasks": ["9"] },
    { "id": 7, "tasks": ["10"] }
  ]
}
```
