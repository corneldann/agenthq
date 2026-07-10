# Requirements Document

## Introduction

This document specifies requirements for adding bidirectional WebSocket communication to AgentHQ. The enhancement enables interactive agent control (cancel, pause, resume), multi-user collaboration, and subscription-filtered real-time updates.

The current system uses unidirectional Server-Sent Events (SSE). This prevents clients from sending commands back to the server, requiring separate HTTP requests for every action.

**Dependencies:** This phase requires Phase 5.1 (Database Layer) to be completed first. The WebSocket layer uses the database for command persistence and status history tracking.

## Glossary

- **AgentHQ**: Developer agent monitoring dashboard built with Bun, TypeScript, and file-based storage
- **SSE**: Server-Sent Events — unidirectional server-to-client push protocol (HTTP-based)
- **WebSocket**: Bidirectional TCP communication protocol for real-time client-server messaging
- **Workspace**: Monitored Kiro agent execution environment with dedicated output/session directories
- **Job**: Agent execution instance with status, logs, and metrics (type: Job)
- **Chain**: Sequence of related sessions grouped by topic (type: Chain)
- **Session**: Kiro conversation state snapshot (type: SessionState)
- **Subscription**: Client registration to receive updates for specific workspace/chain/job
- **Command**: Client-initiated action (cancel job, pause agent, resume agent)
- **Acknowledgement**: Server confirmation of command receipt and processing status
- **Round_Trip_Property**: Serialize-deserialize must preserve original value (parse ∘ format = identity)

## Requirements

### Requirement 1: WebSocket Server Infrastructure

**User Story:** As a dashboard user, I want bidirectional real-time communication with the server, so that I can send commands and receive updates without separate HTTP requests.

#### Acceptance Criteria

1. WHEN a client connects to the WebSocket endpoint at `/ws`, THE WebSocket_Server SHALL upgrade the HTTP connection to WebSocket protocol
2. IF the WebSocket upgrade fails, THEN THE WebSocket_Server SHALL respond with HTTP 400 and error details
3. WHEN a WebSocket connection is established, THE WebSocket_Server SHALL send a `connected` message containing available workspace IDs and a unique client ID
4. WHEN a client sends a `ping` message, THE WebSocket_Server SHALL respond with a `pong` message within 100 milliseconds
5. IF a WebSocket connection is idle for 30 seconds without ping/pong, THEN THE WebSocket_Server SHALL close the connection
6. WHEN a client disconnects, THE WebSocket_Server SHALL attempt to remove all subscriptions for that client ID; IF subscription removal fails, THE WebSocket_Server SHALL log the failure and complete the disconnect process
7. THE WebSocket_Server SHALL support at least 100 concurrent connections with ≤100ms latency per message; THE WebSocket_Server SHALL allow connections beyond 100 and latency beyond 100ms (treat limits as performance guidelines, not hard caps)
8. FOR ALL valid JSON messages M, parse(stringify(M)) SHALL equal M (round-trip property)

### Requirement 2: WebSocket Message Protocol

**User Story:** As a developer, I want a well-defined message protocol, so that client-server communication is predictable and type-safe.

#### Acceptance Criteria

1. THE WebSocket_Message_Parser SHALL reject messages larger than 1MB with error "message too large"
2. IF a client sends a message that fails JSON.parse, THEN THE WebSocket_Server SHALL close the connection immediately with code 1003
3. THE WebSocket_Message_Parser SHALL validate all incoming messages against the ClientMessage type schema
4. IF a client sends an invalid message structure, THEN THE WebSocket_Server SHALL send an error acknowledgement with validation details including field path and expected type
5. THE WebSocket_Server SHALL assign a unique command ID (format: `cmd_${timestamp}_${random}`) to each client command for acknowledgement tracking
6. WHEN a command is processed successfully, THE WebSocket_Server SHALL send an acknowledgement with `success: true` and the command ID; IF the acknowledgement fails to send due to network issues AND the command reached the processing stage, THE WebSocket_Server SHALL retry sending the acknowledgement; acknowledgements SHALL only be sent after command processing completes (successful delivery implies processing completed)
7. WHEN a command fails validation or execution, THE WebSocket_Server SHALL send an acknowledgement with `success: false`, the command ID, and error description

### Requirement 3: Subscription Management

**User Story:** As a dashboard user, I want to subscribe to specific workspaces and chains, so that I only receive relevant updates and reduce bandwidth.

#### Acceptance Criteria

1. WHEN a client sends a `subscribe` message with a workspace ID, THE Subscription_Manager SHALL send an acknowledgement with `success: true`
2. WHEN a client sends a `subscribe` message with a chain ID, THE Subscription_Manager SHALL send an acknowledgement and add that chain to the client's subscription set
3. IF a client subscribes to a workspace already in their subscription set AND the client has actively sent a subscribe request, THEN THE Subscription_Manager SHALL return `{success: true, status: "already_subscribed"}` without creating a duplicate
4. WHEN a client sends an `unsubscribe` message with a non-existent subscription ID, THE Subscription_Manager SHALL return `{success: true, status: "not_subscribed"}` (idempotent)
5. WHEN a client sends an `unsubscribe` message, THE Subscription_Manager SHALL remove the specified subscription from the client's set
6. WHEN a job update occurs, THE WebSocket_Broadcaster SHALL send the update only to clients subscribed to that job's specific chain; IF a client is subscribed to the job's workspace but NOT to the job's chain, the update SHALL NOT be sent
7. THE Subscription_Manager SHALL support at least 10 concurrent subscriptions per client with ≤100ms per subscription operation

### Requirement 4: Interactive Agent Control

**User Story:** As a dashboard user, I want to cancel, pause, and resume agents from the dashboard, so that I can manage agent execution without using the CLI.

#### Acceptance Criteria

1. WHEN a client sends a `cancel-job` command with a job ID that exists in the job registry, THE Job_Controller SHALL terminate the agent process within 5 seconds
2. WHEN a job is cancelled, THE Job_Controller SHALL update the job status to "error" with reason "cancelled by user" in the database
3. WHEN a client sends a `pause-agent` command with a session hash in "running" state, THE Agent_Controller SHALL suspend agent execution within 2 seconds
4. WHEN a client sends a `resume-agent` command with a session hash in "paused" state, THE Agent_Controller SHALL resume agent execution within 2 seconds
5. IF a command targets a non-existent job or session, THEN THE Command_Handler SHALL return an acknowledgement `{success: false, error: "not found", commandId: "..."}`
6. IF a client sends `pause-agent` for a session NOT in "running" state, THEN THE Command_Handler SHALL return `{success: false, error: "invalid state transition: cannot pause from <current_state>"}`
7. THE Command_Handler SHALL validate that the workspace ID matches the job's or session's workspace for ALL commands processed by the Command_Handler, returning error "workspace mismatch" on failure; IF validation fails AND the command cannot execute, the system SHALL still return an error response containing the validation failure details
8. WHEN an agent control command is executed (regardless of whether the state change succeeded), THE WebSocket_Broadcaster SHALL notify all subscribed clients with `{type: "status-change", jobId, oldStatus, newStatus, timestamp, success: boolean}`

### Requirement 5: Multi-User Collaboration

**User Story:** As a team member, I want to see other users' actions in real-time, so that we can coordinate work and avoid conflicts.

#### Acceptance Criteria

1. WHEN a user executes a command, THE WebSocket_Broadcaster SHALL send a `user-action` message `{userId, action, target, timestamp}` to all clients subscribed to the affected workspace
2. WHEN a user commits via the git section, THE WebSocket_Broadcaster SHALL notify all workspace subscribers including the committer within 1 second
3. WHEN a command fails validation or execution, THE WebSocket_Broadcaster SHALL send an error notification `{type: "command-error", userId, commandId, error}` to the originating client only
4. THE WebSocket_Server SHALL support at least 10 concurrent users per workspace; THE WebSocket_Server SHALL guarantee no message loss regardless of the number of active users in the workspace (including 1-2 users)
5. WHEN multiple users send commands concurrently, THE Command_Handler SHALL process them sequentially in arrival order, with each command's acknowledgement sent before processing the next; WHEN there is only one active user, THE Command_Handler SHALL still enforce sequential processing; THE Command_Handler SHALL send acknowledgements regardless of whether commands are actually concurrent

### Requirement 6: Configuration and Environment Variables

**User Story:** As a system administrator, I want to configure WebSocket settings via environment variables, so that I can customize behavior without code changes.

#### Acceptance Criteria

1. THE Configuration_Loader SHALL support `WS_ENABLED` environment variable (true/false, default: true)
2. THE Configuration_Loader SHALL support `WS_IDLE_TIMEOUT` environment variable in seconds (range: 10-300, default: 30)
3. THE Configuration_Loader SHALL support `WS_MAX_MESSAGE_SIZE` environment variable in bytes (range: 1024-10485760, default: 1048576)
4. THE Configuration_Loader SHALL validate all environment variables on startup and log error messages in format "Configuration error: <variable_name>: <specific_issue>" for invalid values

### Requirement 7: Backward Compatibility

**User Story:** As an existing AgentHQ user, I want the upgrade to be seamless, so that I don't need to change my workflow or configuration.

#### Acceptance Criteria

1. THE AgentHQ_Monitor SHALL continue to support SSE via the `/events` endpoint when WS_ENABLED is true
2. THE Dashboard_Frontend SHALL gracefully degrade to SSE if the WebSocket connection fails; specifically, WebSocket constructor failure or close event SHALL trigger fallback to EventSource with configurable reconnection parameters (default: retry 1000ms, max 5 attempts, overridable via environment or config)

### Requirement 8: Error Handling and Resilience

**User Story:** As a system administrator, I want the system to handle errors gracefully, so that partial failures don't crash the entire monitor.

#### Acceptance Criteria

1. IF a WebSocket client sends a message that fails JSON.parse, THEN THE Message_Handler SHALL log error "WebSocket message parse failed: <error.message>" and close the connection with code 1003
2. THE WebSocket_Server SHALL automatically close and clean up connections that have been idle (no messages sent or received in either direction) for more than 60 seconds

### Requirement 9: Logging and Observability

**User Story:** As a developer, I want detailed logs, so that I can diagnose issues and monitor system health.

#### Acceptance Criteria

1. THE WebSocket_Server SHALL log all connection events (connect, disconnect, error) with fields: {level, event_type, client_id, timestamp, remote_ip}
2. THE Command_Handler SHALL log all user commands with fields: {level, user_id, command_type, target_entity_id, execution_result, duration_ms}
3. THE Error_Logger SHALL include stack traces with severity levels (DEBUG < INFO < WARN < ERROR < FATAL) for all unexpected errors (errors not matching known error patterns in validation or user input handling)

### Requirement 10: Security and Validation

**User Story:** As a security-conscious developer, I want input validation and safe command execution, so that the system is protected from malicious clients.

#### Acceptance Criteria

1. THE WebSocket_Message_Validator SHALL reject messages with unexpected fields or invalid types
2. WHEN the system is executing commands, THE Command_Handler SHALL validate that workspace IDs in commands match existing workspaces before execution
3. THE WebSocket_Server SHALL enforce a maximum message size of 1MB payload, with tolerance allowed for protocol-level overhead such as headers and framing metadata; messages slightly above 1MB (within reasonable protocol overhead buffer) SHALL be accepted

### Requirement 11: Testing and Verification

**User Story:** As a developer, I want comprehensive tests, so that I can refactor with confidence and catch regressions early.

#### Acceptance Criteria

1. THE Test_Suite SHALL include property-based tests for round-trip serialization of WebSocket messages
2. THE Test_Suite SHALL include integration tests for WebSocket flows (connect, subscribe, command, broadcast)
3. THE Test_Suite SHALL include tests for concurrent WebSocket connections: ≥10 concurrent connections sending commands simultaneously SHALL all receive acknowledgements with ≤500ms latency and correct results
