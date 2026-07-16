/**
 * WebSocket configuration loader.
 *
 * Reads WS_ENABLED, WS_IDLE_TIMEOUT, and WS_MAX_MESSAGE_SIZE from the
 * environment, validates and clamps numeric values, and logs a warning for
 * each out-of-range value rather than throwing.
 */

export type WsConfig = {
  /** Whether the WebSocket layer is active. Default: true */
  enabled: boolean;
  /** Idle connection timeout in seconds. Range: [10, 300]. Default: 30 */
  idleTimeout: number;
  /** Maximum inbound message size in bytes. Range: [1024, 10485760]. Default: 1048576 (1 MB) */
  maxMessageSize: number;
};

const IDLE_TIMEOUT_MIN = 10;
const IDLE_TIMEOUT_MAX = 300;
const IDLE_TIMEOUT_DEFAULT = 30;

const MAX_MESSAGE_SIZE_MIN = 1024;
const MAX_MESSAGE_SIZE_MAX = 10485760;
const MAX_MESSAGE_SIZE_DEFAULT = 1048576;

/**
 * Parse and validate WebSocket configuration from environment variables.
 *
 * Out-of-range numeric values are clamped to the nearest boundary and a
 * warning is logged — this function never throws.
 *
 * @param env - An object of environment variable key/value pairs
 *              (pass `process.env` in production, a plain object in tests).
 * @returns Validated {@link WsConfig}
 */
export function loadWsConfig(env: Record<string, string | undefined>): WsConfig {
  // --- WS_ENABLED ---
  // Any value other than exactly "false" (case-insensitive) is truthy.
  const rawEnabled = env['WS_ENABLED'];
  const enabled = rawEnabled?.toLowerCase() !== 'false';

  // --- WS_IDLE_TIMEOUT ---
  const rawIdleTimeout = env['WS_IDLE_TIMEOUT'];
  const parsedIdleTimeout = parseInt(rawIdleTimeout ?? String(IDLE_TIMEOUT_DEFAULT), 10);
  const idleTimeoutRaw = isNaN(parsedIdleTimeout) ? IDLE_TIMEOUT_DEFAULT : parsedIdleTimeout;

  if (idleTimeoutRaw < IDLE_TIMEOUT_MIN || idleTimeoutRaw > IDLE_TIMEOUT_MAX) {
    const issue =
      idleTimeoutRaw < IDLE_TIMEOUT_MIN
        ? `value ${idleTimeoutRaw} is below minimum ${IDLE_TIMEOUT_MIN}, clamped to ${IDLE_TIMEOUT_MIN}`
        : `value ${idleTimeoutRaw} is above maximum ${IDLE_TIMEOUT_MAX}, clamped to ${IDLE_TIMEOUT_MAX}`;
    console.warn(`Configuration error: WS_IDLE_TIMEOUT: ${issue}`);
  }

  const idleTimeout = Math.max(IDLE_TIMEOUT_MIN, Math.min(IDLE_TIMEOUT_MAX, idleTimeoutRaw));

  // --- WS_MAX_MESSAGE_SIZE ---
  const rawMaxMessageSize = env['WS_MAX_MESSAGE_SIZE'];
  const parsedMaxMessageSize = parseInt(rawMaxMessageSize ?? String(MAX_MESSAGE_SIZE_DEFAULT), 10);
  const maxMessageSizeRaw = isNaN(parsedMaxMessageSize) ? MAX_MESSAGE_SIZE_DEFAULT : parsedMaxMessageSize;

  if (maxMessageSizeRaw < MAX_MESSAGE_SIZE_MIN || maxMessageSizeRaw > MAX_MESSAGE_SIZE_MAX) {
    const issue =
      maxMessageSizeRaw < MAX_MESSAGE_SIZE_MIN
        ? `value ${maxMessageSizeRaw} is below minimum ${MAX_MESSAGE_SIZE_MIN}, clamped to ${MAX_MESSAGE_SIZE_MIN}`
        : `value ${maxMessageSizeRaw} is above maximum ${MAX_MESSAGE_SIZE_MAX}, clamped to ${MAX_MESSAGE_SIZE_MAX}`;
    console.warn(`Configuration error: WS_MAX_MESSAGE_SIZE: ${issue}`);
  }

  const maxMessageSize = Math.max(
    MAX_MESSAGE_SIZE_MIN,
    Math.min(MAX_MESSAGE_SIZE_MAX, maxMessageSizeRaw),
  );

  return { enabled, idleTimeout, maxMessageSize };
}
