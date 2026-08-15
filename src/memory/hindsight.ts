// ---------------------------------------------------------------------------
// HindsightAdapter — thin HTTP client implementing IMemoryClient.
// Posts MCP tool-call payloads to {baseUrl}/mcp. No scope mapping, quality
// gating, or retry logic here — those concerns belong to the circuit breaker
// and retry queue layers above.
// ---------------------------------------------------------------------------

import type { IMemoryClient, Memory, MemoryScope } from './types.ts';
import {
  MemoryClientError,
  MemoryServiceError,
  MemoryTimeoutError,
} from './errors.ts';

// ---------------------------------------------------------------------------
// MCP payload shapes
// ---------------------------------------------------------------------------

type McpToolCall = {
  method: 'tools/call';
  params: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

type McpResponse = {
  content?: unknown;
  result?: unknown;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * POST a single MCP tool-call payload to {baseUrl}/mcp and return the parsed
 * response body. All HTTP-error classification and timeout handling live here.
 *
 * Throws:
 * - MemoryTimeoutError   — fetch aborted after 5 000 ms
 * - MemoryClientError    — HTTP 4xx response
 * - MemoryServiceError   — HTTP 5xx, 1xx, or network-level failure (statusCode 0)
 */
async function postMcp(baseUrl: string, payload: McpToolCall): Promise<McpResponse> {
  let response: Response;

  try {
    response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err: unknown) {
    // AbortError fired by AbortSignal.timeout → MemoryTimeoutError
    if (isAbortError(err)) {
      throw new MemoryTimeoutError(
        `Hindsight request timed out after 5 000 ms (tool: ${payload.params.name})`,
      );
    }
    // Any other network-level error (DNS failure, connection refused, etc.)
    const message = err instanceof Error ? err.message : String(err);
    throw new MemoryServiceError(
      `Hindsight network error: ${message} (tool: ${payload.params.name})`,
      0,
    );
  }

  const status = response.status;

  // HTTP 1xx — protocol violation
  if (status >= 100 && status <= 199) {
    throw new MemoryServiceError(
      `Hindsight returned unexpected 1xx status ${status} (tool: ${payload.params.name})`,
      status,
    );
  }

  // HTTP 4xx — caller error
  if (status >= 400 && status <= 499) {
    const body = await readBodySafe(response);
    throw new MemoryClientError(
      `Hindsight rejected request with status ${status} (tool: ${payload.params.name})`,
      status,
      body,
    );
  }

  // HTTP 5xx — service error
  if (status >= 500 && status <= 599) {
    throw new MemoryServiceError(
      `Hindsight returned server error ${status} (tool: ${payload.params.name})`,
      status,
    );
  }

  // 2xx / 3xx — success; parse and return
  return response.json() as Promise<McpResponse>;
}

/** Returns true when err looks like a DOM AbortError. */
function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

/** Read response body text without throwing. Returns '' on failure. */
async function readBodySafe(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// HindsightAdapter
// ---------------------------------------------------------------------------

export class HindsightAdapter implements IMemoryClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl;
  }

  async retain(text: string, scope: MemoryScope): Promise<string> {
    const result = await postMcp(this.#baseUrl, {
      method: 'tools/call',
      params: {
        name: 'memory_retain',
        arguments: { text, scope },
      },
    });
    return extractString(result, 'id') ?? '';
  }

  async recall(query: string, scope: MemoryScope, limit: number): Promise<Memory[]> {
    const result = await postMcp(this.#baseUrl, {
      method: 'tools/call',
      params: {
        name: 'memory_recall',
        arguments: { query, scope, limit },
      },
    });
    return extractArray(result) as Memory[];
  }

  async reflect(topic: string, scope: MemoryScope): Promise<string | null> {
    const result = await postMcp(this.#baseUrl, {
      method: 'tools/call',
      params: {
        name: 'memory_reflect',
        arguments: { topic, scope },
      },
    });
    return extractString(result, 'reflection') ?? null;
  }

  async delete(id: string): Promise<void> {
    await postMcp(this.#baseUrl, {
      method: 'tools/call',
      params: {
        name: 'memory_delete',
        arguments: { id },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Response extraction helpers
// ---------------------------------------------------------------------------

/**
 * Attempt to extract a named string field from an MCP response.
 * Tries `result.<field>` then `content.<field>` then top-level `.<field>`.
 * Returns undefined when not found.
 */
function extractString(response: McpResponse, field: string): string | undefined {
  const candidates: unknown[] = [
    (response as Record<string, unknown>)[field],
    isRecord(response.result) ? (response.result as Record<string, unknown>)[field] : undefined,
    isRecord(response.content) ? (response.content as Record<string, unknown>)[field] : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Attempt to extract an array from an MCP response.
 * Returns [] when the response contains no recognisable array.
 */
function extractArray(response: McpResponse): unknown[] {
  const candidates: unknown[] = [
    response.result,
    response.content,
    (response as Record<string, unknown>)['items'],
    (response as Record<string, unknown>)['memories'],
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
