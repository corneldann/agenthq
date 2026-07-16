/**
 * Tests for src/ws/protocol.ts
 *
 * Covers:
 *  - Unit tests for parseClientMessage (all six variants + rejection cases)
 *  - Property-based round-trip test (all six variants via fast-check)
 *
 * Validates: Requirements 2.3, 2.4, 11.1
 */

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';
import { parseClientMessage, type ClientMessage } from '../../src/ws/protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid commandId that matches /^cmd_\d+_[a-z0-9]+$/ */
const VALID_COMMAND_ID = 'cmd_1700000000000_abc123';

// ---------------------------------------------------------------------------
// Valid message variants
// ---------------------------------------------------------------------------

describe('parseClientMessage() — valid variants', () => {
  it('should parse a valid subscribe message with no optional fields', () => {
    const msg: ClientMessage = { type: 'subscribe', commandId: VALID_COMMAND_ID };
    const result = parseClientMessage(msg);
    expect(result.success).toBe(true);
    expect(result.value).toEqual(msg);
  });

  it('should parse a valid subscribe message with workspaceId', () => {
    const msg: ClientMessage = { type: 'subscribe', workspaceId: 'ws-1', commandId: VALID_COMMAND_ID };
    const result = parseClientMessage(msg);
    expect(result.success).toBe(true);
    expect(result.value).toEqual(msg);
  });

  it('should parse a valid subscribe message with workspaceId and chainId', () => {
    const msg: ClientMessage = { type: 'subscribe', workspaceId: 'ws-1', chainId: 'chain-1', commandId: VALID_COMMAND_ID };
    const result = parseClientMessage(msg);
    expect(result.success).toBe(true);
    expect(result.value).toEqual(msg);
  });

  it('should parse a valid unsubscribe message', () => {
    const msg: ClientMessage = { type: 'unsubscribe', subscriptionId: 'sub_123_abc', commandId: VALID_COMMAND_ID };
    const result = parseClientMessage(msg);
    expect(result.success).toBe(true);
    expect(result.value).toEqual(msg);
  });

  it('should parse a valid ping message', () => {
    const msg: ClientMessage = { type: 'ping', commandId: VALID_COMMAND_ID };
    const result = parseClientMessage(msg);
    expect(result.success).toBe(true);
    expect(result.value).toEqual(msg);
  });

  it('should parse a valid cancel-job message', () => {
    const msg: ClientMessage = { type: 'cancel-job', jobId: 'job-abc', workspaceId: 'ws-1', commandId: VALID_COMMAND_ID };
    const result = parseClientMessage(msg);
    expect(result.success).toBe(true);
    expect(result.value).toEqual(msg);
  });

  it('should parse a valid pause-agent message', () => {
    const msg: ClientMessage = { type: 'pause-agent', sessionHash: 'hash-abc', workspaceId: 'ws-1', commandId: VALID_COMMAND_ID };
    const result = parseClientMessage(msg);
    expect(result.success).toBe(true);
    expect(result.value).toEqual(msg);
  });

  it('should parse a valid resume-agent message', () => {
    const msg: ClientMessage = { type: 'resume-agent', sessionHash: 'hash-abc', workspaceId: 'ws-1', commandId: VALID_COMMAND_ID };
    const result = parseClientMessage(msg);
    expect(result.success).toBe(true);
    expect(result.value).toEqual(msg);
  });
});

// ---------------------------------------------------------------------------
// Non-object / null rejection
// ---------------------------------------------------------------------------

describe('parseClientMessage() — null and non-object rejection', () => {
  it('should reject null', () => {
    const result = parseClientMessage(null);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Message must be an object');
  });

  it('should reject a string', () => {
    const result = parseClientMessage('{"type":"ping"}');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Message must be an object');
  });

  it('should reject a number', () => {
    const result = parseClientMessage(42);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Message must be an object');
  });

  it('should reject undefined', () => {
    const result = parseClientMessage(undefined);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Message must be an object');
  });
});

// ---------------------------------------------------------------------------
// Missing / invalid type field
// ---------------------------------------------------------------------------

describe('parseClientMessage() — type field validation', () => {
  it('should reject a message with no type field', () => {
    const result = parseClientMessage({ commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing or invalid type field');
  });

  it('should reject a message where type is a number', () => {
    const result = parseClientMessage({ type: 99, commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing or invalid type field');
  });

  it('should reject an unknown type value', () => {
    const result = parseClientMessage({ type: 'broadcast', commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown message type');
  });
});

// ---------------------------------------------------------------------------
// commandId validation
// ---------------------------------------------------------------------------

describe('parseClientMessage() — commandId validation', () => {
  it('should reject a message with no commandId', () => {
    const result = parseClientMessage({ type: 'ping' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing or invalid commandId field');
  });

  it('should reject a commandId without the cmd_ prefix', () => {
    const result = parseClientMessage({ type: 'ping', commandId: '1700000000000_abc123' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid commandId format');
  });

  it('should reject a commandId that is just "cmd_"', () => {
    const result = parseClientMessage({ type: 'ping', commandId: 'cmd_' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid commandId format');
  });

  it('should reject a commandId with uppercase letters in the random part', () => {
    const result = parseClientMessage({ type: 'ping', commandId: 'cmd_1700000000000_ABC123' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid commandId format');
  });

  it('should reject a commandId with non-digit timestamp part', () => {
    const result = parseClientMessage({ type: 'ping', commandId: 'cmd_abc_xyz' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid commandId format');
  });

  it('should reject a commandId that is a number type', () => {
    const result = parseClientMessage({ type: 'ping', commandId: 12345 });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing or invalid commandId field');
  });
});

// ---------------------------------------------------------------------------
// cancel-job field validation
// ---------------------------------------------------------------------------

describe('parseClientMessage() — cancel-job field validation', () => {
  it('should reject cancel-job missing jobId', () => {
    const result = parseClientMessage({ type: 'cancel-job', workspaceId: 'ws-1', commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing jobId or workspaceId');
  });

  it('should reject cancel-job missing workspaceId', () => {
    const result = parseClientMessage({ type: 'cancel-job', jobId: 'job-1', commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing jobId or workspaceId');
  });

  it('should reject cancel-job with numeric jobId', () => {
    const result = parseClientMessage({ type: 'cancel-job', jobId: 99, workspaceId: 'ws-1', commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing jobId or workspaceId');
  });
});

// ---------------------------------------------------------------------------
// pause-agent / resume-agent field validation
// ---------------------------------------------------------------------------

describe('parseClientMessage() — pause-agent / resume-agent field validation', () => {
  it('should reject pause-agent missing sessionHash', () => {
    const result = parseClientMessage({ type: 'pause-agent', workspaceId: 'ws-1', commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing sessionHash or workspaceId');
  });

  it('should reject pause-agent missing workspaceId', () => {
    const result = parseClientMessage({ type: 'pause-agent', sessionHash: 'hash-1', commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing sessionHash or workspaceId');
  });

  it('should reject resume-agent missing sessionHash', () => {
    const result = parseClientMessage({ type: 'resume-agent', workspaceId: 'ws-1', commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Missing sessionHash or workspaceId');
  });
});

// ---------------------------------------------------------------------------
// subscribe optional field type checking
// ---------------------------------------------------------------------------

describe('parseClientMessage() — subscribe optional field type checking', () => {
  it('should reject subscribe with numeric workspaceId', () => {
    const result = parseClientMessage({ type: 'subscribe', workspaceId: 42, commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid workspaceId field');
  });

  it('should reject subscribe with numeric chainId', () => {
    const result = parseClientMessage({ type: 'subscribe', chainId: 42, commandId: VALID_COMMAND_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid chainId field');
  });
});

// ---------------------------------------------------------------------------
// Property-based round-trip test
//
// Validates: Requirements 11.1
// **Validates: Requirements 1.8, 11.1**
// ---------------------------------------------------------------------------

/**
 * Generates valid commandId strings matching /^cmd_\d+_[a-z0-9]+$/
 */
const commandIdArb = fc
  .tuple(
    fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    fc.stringMatching(/^[a-z0-9]{1,12}$/)
  )
  .map(([ts, rand]) => `cmd_${ts}_${rand}`);

/** Non-empty string that survives JSON serialization unchanged */
const safeStringArb = fc.string({ minLength: 1, maxLength: 40 }).filter(
  (s) => s === JSON.parse(JSON.stringify(s))
);

/**
 * Arbitrary valid ClientMessage covering all six variants.
 */
const clientMessageArb: fc.Arbitrary<ClientMessage> = fc.oneof(
  // subscribe — no optional fields
  fc.record({ type: fc.constant('subscribe' as const), commandId: commandIdArb }),
  // subscribe — with workspaceId
  fc.record({ type: fc.constant('subscribe' as const), commandId: commandIdArb, workspaceId: safeStringArb }),
  // subscribe — with both optional fields
  fc.record({ type: fc.constant('subscribe' as const), commandId: commandIdArb, workspaceId: safeStringArb, chainId: safeStringArb }),
  // unsubscribe
  fc.record({ type: fc.constant('unsubscribe' as const), commandId: commandIdArb, subscriptionId: safeStringArb }),
  // ping
  fc.record({ type: fc.constant('ping' as const), commandId: commandIdArb }),
  // cancel-job
  fc.record({ type: fc.constant('cancel-job' as const), commandId: commandIdArb, jobId: safeStringArb, workspaceId: safeStringArb }),
  // pause-agent
  fc.record({ type: fc.constant('pause-agent' as const), commandId: commandIdArb, sessionHash: safeStringArb, workspaceId: safeStringArb }),
  // resume-agent
  fc.record({ type: fc.constant('resume-agent' as const), commandId: commandIdArb, sessionHash: safeStringArb, workspaceId: safeStringArb })
);

describe('parseClientMessage() — round-trip property', () => {
  it('property: parse(JSON.parse(JSON.stringify(msg))) deep-equals original for all valid ClientMessage variants', () => {
    fc.assert(
      fc.property(clientMessageArb, (msg) => {
        const roundTripped = JSON.parse(JSON.stringify(msg));
        const result = parseClientMessage(roundTripped);
        if (!result.success || result.value === undefined) {
          return false;
        }
        expect(result.value).toEqual(msg);
        return true;
      }),
      { numRuns: 200, verbose: false }
    );
  });
});
