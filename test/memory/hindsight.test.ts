import { describe, it, expect, mock, beforeEach, afterEach, afterAll } from 'bun:test';
import * as fc from 'fast-check';
import { HindsightAdapter } from '../../src/memory/hindsight.ts';
import {
  MemoryClientError,
  MemoryServiceError,
  MemoryTimeoutError,
} from '../../src/memory/errors.ts';
import type { MemoryScope } from '../../src/memory/types.ts';

// ---------------------------------------------------------------------------
// Mock fetch at module level — HindsightAdapter uses global fetch internally
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;

const mockFetch = mock(() =>
  Promise.resolve(new Response(JSON.stringify({ result: [] }), { status: 200 })),
);
global.fetch = mockFetch as unknown as typeof fetch;

// Restore global fetch after all tests in this file complete so the mock
// does not leak into other test files (e.g. api.integration.test.ts).
afterAll(() => {
  global.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_URL = 'http://hindsight.test:3100';

const scope: MemoryScope = { workspaceId: 'ws-1' };

function makeMockResponse(status: number, body = ''): Response {
  // The Response constructor rejects status codes below 200 (except 101).
  // For 1xx simulation we build a minimal response-shaped object instead.
  if (status < 200 && status !== 101) {
    return {
      status,
      ok: false,
      text: () => Promise.resolve(body),
      json: () => Promise.resolve({}),
    } as unknown as Response;
  }
  return new Response(body, { status });
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('HindsightAdapter — URL construction', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('should POST to {baseUrl}/mcp for retain', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { id: 'mem-1' } }), { status: 200 }),
    );
    const adapter = new HindsightAdapter(BASE_URL);
    await adapter.retain('some text', scope);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = (mockFetch.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/mcp`);
  });

  it('should POST to {baseUrl}/mcp for recall', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: [] }), { status: 200 }),
    );
    const adapter = new HindsightAdapter(BASE_URL);
    await adapter.recall('query', scope, 5);

    const [url] = (mockFetch.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/mcp`);
  });

  it('should POST to {baseUrl}/mcp for reflect', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { reflection: null } }), { status: 200 }),
    );
    const adapter = new HindsightAdapter(BASE_URL);
    await adapter.reflect('topic', scope);

    const [url] = (mockFetch.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/mcp`);
  });

  it('should POST to {baseUrl}/mcp for delete', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const adapter = new HindsightAdapter(BASE_URL);
    await adapter.delete('mem-id-1');

    const [url] = (mockFetch.mock.calls[0] as unknown) as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/mcp`);
  });
});

describe('HindsightAdapter — MCP payload shape', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('should send correct MCP payload for retain', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { id: 'mem-abc' } }), { status: 200 }),
    );
    const adapter = new HindsightAdapter(BASE_URL);
    await adapter.retain('hello world', scope);

    const [, init] = (mockFetch.mock.calls[0] as unknown) as [string, RequestInit];
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'memory_retain',
        arguments: { text: 'hello world', scope },
      },
    });
  });

  it('should send correct MCP payload for recall', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: [] }), { status: 200 }),
    );
    const adapter = new HindsightAdapter(BASE_URL);
    await adapter.recall('search query', scope, 10);

    const [, init] = (mockFetch.mock.calls[0] as unknown) as [string, RequestInit];
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'memory_recall',
        arguments: { query: 'search query', scope, limit: 10 },
      },
    });
  });

  it('should send correct MCP payload for reflect', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { reflection: 'insight' } }), { status: 200 }),
    );
    const adapter = new HindsightAdapter(BASE_URL);
    await adapter.reflect('the topic', scope);

    const [, init] = (mockFetch.mock.calls[0] as unknown) as [string, RequestInit];
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'memory_reflect',
        arguments: { topic: 'the topic', scope },
      },
    });
  });

  it('should send correct MCP payload for delete', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const adapter = new HindsightAdapter(BASE_URL);
    await adapter.delete('mem-xyz');

    const [, init] = (mockFetch.mock.calls[0] as unknown) as [string, RequestInit];
    const body = JSON.parse(init.body as string) as unknown;
    expect(body).toMatchObject({
      method: 'tools/call',
      params: {
        name: 'memory_delete',
        arguments: { id: 'mem-xyz' },
      },
    });
  });
});

describe('HindsightAdapter — timeout handling', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    // Reset to default safe implementation so the mock does not persist.
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ result: [] }), { status: 200 })),
    );
  });

  it('should throw MemoryTimeoutError when fetch is aborted with AbortError', async () => {
    mockFetch.mockImplementation(() => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      return Promise.reject(err);
    });

    const adapter = new HindsightAdapter(BASE_URL);
    await expect(adapter.retain('text', scope)).rejects.toBeInstanceOf(MemoryTimeoutError);
  });

  it('should throw MemoryTimeoutError when fetch is aborted with TimeoutError', async () => {
    mockFetch.mockImplementation(() => {
      const err = new DOMException('The operation timed out', 'TimeoutError');
      return Promise.reject(err);
    });

    const adapter = new HindsightAdapter(BASE_URL);
    await expect(adapter.retain('text', scope)).rejects.toBeInstanceOf(MemoryTimeoutError);
  });
});

describe('HindsightAdapter — network errors', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    // Reset to default safe implementation so the mock does not persist
    // across describe blocks or into other test files.
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ result: [] }), { status: 200 })),
    );
  });

  it('should throw MemoryServiceError with statusCode 0 on network failure', async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error('connection refused')));

    const adapter = new HindsightAdapter(BASE_URL);
    const err = await adapter.retain('text', scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryServiceError);
    expect((err as MemoryServiceError).statusCode).toBe(0);
  });
});

describe('HindsightAdapter — HTTP 4xx errors', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('should throw MemoryClientError with statusCode 404 and body for a 404 response', async () => {
    mockFetch.mockResolvedValueOnce(makeMockResponse(404, 'not found'));

    const adapter = new HindsightAdapter(BASE_URL);
    const err = await adapter.retain('text', scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryClientError);
    expect((err as MemoryClientError).statusCode).toBe(404);
    expect((err as MemoryClientError).body).toBe('not found');
  });
});

describe('HindsightAdapter — HTTP 5xx errors', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('should throw MemoryServiceError with statusCode 503 for a 503 response', async () => {
    mockFetch.mockResolvedValueOnce(makeMockResponse(503, 'service unavailable'));

    const adapter = new HindsightAdapter(BASE_URL);
    const err = await adapter.retain('text', scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryServiceError);
    expect((err as MemoryServiceError).statusCode).toBe(503);
  });
});

describe('HindsightAdapter — HTTP 1xx errors', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('should throw MemoryServiceError with statusCode 100 for a 1xx response', async () => {
    mockFetch.mockResolvedValueOnce(makeMockResponse(100, ''));

    const adapter = new HindsightAdapter(BASE_URL);
    const err = await adapter.retain('text', scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MemoryServiceError);
    expect((err as MemoryServiceError).statusCode).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('HindsightAdapter — property tests', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  // Feature: phase-6.1-memory-infrastructure, Property 3: HindsightAdapter maps HTTP 4xx to MemoryClientError with correct statusCode
  it('property: maps any HTTP 4xx to MemoryClientError with matching statusCode', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 400, max: 499 }), async (status) => {
        mockFetch.mockResolvedValueOnce(makeMockResponse(status, 'client error body'));

        const adapter = new HindsightAdapter(BASE_URL);
        const err = await adapter.retain('text', scope).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(MemoryClientError);
        expect((err as MemoryClientError).statusCode).toBe(status);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: phase-6.1-memory-infrastructure, Property 4: HindsightAdapter maps HTTP 5xx to MemoryServiceError with correct statusCode
  it('property: maps any HTTP 5xx to MemoryServiceError with matching statusCode', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 500, max: 599 }), async (status) => {
        mockFetch.mockResolvedValueOnce(makeMockResponse(status, 'server error'));

        const adapter = new HindsightAdapter(BASE_URL);
        const err = await adapter.retain('text', scope).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(MemoryServiceError);
        expect((err as MemoryServiceError).statusCode).toBe(status);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: phase-6.1-memory-infrastructure, Property 5: HindsightAdapter maps HTTP 1xx to MemoryServiceError with correct statusCode
  it('property: maps any HTTP 1xx to MemoryServiceError with matching statusCode', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 100, max: 199 }), async (status) => {
        mockFetch.mockResolvedValueOnce(makeMockResponse(status, ''));

        const adapter = new HindsightAdapter(BASE_URL);
        const err = await adapter.retain('text', scope).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(MemoryServiceError);
        expect((err as MemoryServiceError).statusCode).toBe(status);
      }),
      { numRuns: 100 },
    );
  });
});
