import { describe, it, expect } from 'bun:test';
import { scopeFromJob, scopeFromChain } from '../../src/memory/scopes.ts';
import type { Job, Chain } from '../../src/types.ts';
import type { SessionState } from '../../src/types.ts';

// ---------------------------------------------------------------------------
// Minimal typed stubs — only the fields required by the functions under test.
// Using Pick<> keeps the stubs narrow without reaching for `as any`.
// ---------------------------------------------------------------------------

type JobStub = Pick<Job, 'id' | 'workspaceId' | 'agent'> & Partial<Job>;
type ChainStub = Pick<Chain, 'chainId' | 'workspaceId'> & Partial<Chain>;

function makeJob(overrides: { id: string; workspaceId: string; agent: string }): Job {
  const stub: JobStub = {
    id: overrides.id,
    workspaceId: overrides.workspaceId,
    agent: overrides.agent,
    name: 'stub-job',
    jobChain: 'stub-chain',
    sessionChainId: 'stub-session',
    timestamp: new Date().toISOString(),
    type: 'stub',
    status: 'done',
    lines: 0,
    lastLine: '',
    hasLog: false,
    logError: false,
    mdFile: '',
    logFile: '',
    agentDone: '',
    sizeBytes: 0,
  };
  return stub as Job;
}

function makeChain(overrides: { chainId: string; workspaceId: string }): Chain {
  const stub: ChainStub = {
    chainId: overrides.chainId,
    workspaceId: overrides.workspaceId,
    displayName: 'stub-chain',
    nextIndex: 1,
    sessions: [],
    totalMessages: 0,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
  };
  return stub as Chain;
}

// ---------------------------------------------------------------------------
// scopeFromJob
// ---------------------------------------------------------------------------

describe('scopeFromJob', () => {
  it('should map workspaceId from job.workspaceId', () => {
    // Arrange
    const job = makeJob({ id: 'job-1', workspaceId: 'ws-abc', agent: 'claude' });

    // Act
    const scope = scopeFromJob(job);

    // Assert
    expect(scope.workspaceId).toBe('ws-abc');
  });

  it('should map agentId from job.agent', () => {
    // Arrange
    const job = makeJob({ id: 'job-1', workspaceId: 'ws-abc', agent: 'claude-opus' });

    // Act
    const scope = scopeFromJob(job);

    // Assert
    expect(scope.agentId).toBe('claude-opus');
  });

  it('should map runId from job.id', () => {
    // Arrange
    const job = makeJob({ id: 'job-xyz-42', workspaceId: 'ws-abc', agent: 'claude' });

    // Act
    const scope = scopeFromJob(job);

    // Assert
    expect(scope.runId).toBe('job-xyz-42');
  });

  it('should set exactly workspaceId, agentId, runId — no extra fields', () => {
    // Arrange
    const job = makeJob({ id: 'job-1', workspaceId: 'ws-abc', agent: 'claude' });

    // Act
    const scope = scopeFromJob(job);

    // Assert — only the three expected keys present
    const keys = Object.keys(scope).sort();
    expect(keys).toStrictEqual(['agentId', 'runId', 'workspaceId']);
  });

  it('should preserve distinct values for distinct jobs', () => {
    // Arrange
    const jobA = makeJob({ id: 'id-a', workspaceId: 'ws-1', agent: 'agent-1' });
    const jobB = makeJob({ id: 'id-b', workspaceId: 'ws-2', agent: 'agent-2' });

    // Act
    const scopeA = scopeFromJob(jobA);
    const scopeB = scopeFromJob(jobB);

    // Assert
    expect(scopeA.workspaceId).toBe('ws-1');
    expect(scopeA.agentId).toBe('agent-1');
    expect(scopeA.runId).toBe('id-a');

    expect(scopeB.workspaceId).toBe('ws-2');
    expect(scopeB.agentId).toBe('agent-2');
    expect(scopeB.runId).toBe('id-b');
  });
});

// ---------------------------------------------------------------------------
// scopeFromChain
// ---------------------------------------------------------------------------

describe('scopeFromChain', () => {
  it('should map workspaceId from chain.workspaceId', () => {
    // Arrange
    const chain = makeChain({ chainId: 'chain-001', workspaceId: 'ws-xyz' });

    // Act
    const scope = scopeFromChain(chain);

    // Assert
    expect(scope.workspaceId).toBe('ws-xyz');
  });

  it('should map chainId from chain.chainId', () => {
    // Arrange
    const chain = makeChain({ chainId: 'chain-abc-99', workspaceId: 'ws-xyz' });

    // Act
    const scope = scopeFromChain(chain);

    // Assert
    expect(scope.chainId).toBe('chain-abc-99');
  });

  it('should set exactly workspaceId and chainId — no extra fields', () => {
    // Arrange
    const chain = makeChain({ chainId: 'chain-001', workspaceId: 'ws-xyz' });

    // Act
    const scope = scopeFromChain(chain);

    // Assert — only the two expected keys present
    const keys = Object.keys(scope).sort();
    expect(keys).toStrictEqual(['chainId', 'workspaceId']);
  });

  it('should preserve distinct values for distinct chains', () => {
    // Arrange
    const chainA = makeChain({ chainId: 'chain-a', workspaceId: 'ws-1' });
    const chainB = makeChain({ chainId: 'chain-b', workspaceId: 'ws-2' });

    // Act
    const scopeA = scopeFromChain(chainA);
    const scopeB = scopeFromChain(chainB);

    // Assert
    expect(scopeA.workspaceId).toBe('ws-1');
    expect(scopeA.chainId).toBe('chain-a');

    expect(scopeB.workspaceId).toBe('ws-2');
    expect(scopeB.chainId).toBe('chain-b');
  });
});
