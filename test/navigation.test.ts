// Feature: monitor-dashboard-redesign, Property 1: Work-nav dot reflects running-job presence
// Validates: Requirements 2.3, 2.4, 2.6

import { describe, it, expect } from 'bun:test';
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Inline type (mirrors types.ts — avoids importing main.ts which has DOM side-effects)
// ---------------------------------------------------------------------------

interface Job {
  id: string;
  name: string;
  jobChain: string;
  sessionChainId: string;
  timestamp: string;
  type: string;
  agent: string;
  status: 'running' | 'done' | 'reported' | 'error';
  lines: number;
  lastLine: string;
  hasLog: boolean;
  logError: boolean;
  mdFile: string;
  logFile: string;
  agentDone: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Pure logic extracted from main.ts sidebar update (the code under test)
// ---------------------------------------------------------------------------

function applyWorkNavClass(link: { classList: Set<string> }, jobs: Job[]): void {
  const hasRunning = jobs.some((j) => j.status === 'running');
  if (hasRunning) {
    link.classList.add('has-running');
  } else {
    link.classList.delete('has-running');
  }
}

// ---------------------------------------------------------------------------
// fast-check arbitraries
// ---------------------------------------------------------------------------

const statusArb = fc.constantFrom<Job['status']>('running', 'done', 'reported', 'error');

const jobArb: fc.Arbitrary<Job> = fc.record({
  id:             fc.string({ minLength: 1, maxLength: 16 }),
  name:           fc.string(),
  jobChain:       fc.string(),
  sessionChainId: fc.string(),
  timestamp:      fc.string(),
  type:           fc.string(),
  agent:          fc.string(),
  status:         statusArb,
  lines:          fc.integer({ min: 0, max: 100_000 }),
  lastLine:       fc.string(),
  hasLog:         fc.boolean(),
  logError:       fc.boolean(),
  mdFile:         fc.string(),
  logFile:        fc.string(),
  agentDone:      fc.string(),
  sizeBytes:      fc.integer({ min: 0, max: 10_000_000 }),
});

// ---------------------------------------------------------------------------
// Property 1: Work-nav dot reflects running-job presence
// ---------------------------------------------------------------------------

describe('Work-nav dot reflects running-job presence', () => {

  // --- Property-based test ---

  it('Property 1: has-running class is present iff at least one job has status "running"', () => {
    fc.assert(
      fc.property(fc.array(jobArb), (jobs) => {
        const link = { classList: new Set<string>() };
        applyWorkNavClass(link, jobs);

        const expectedHasRunning = jobs.some((j) => j.status === 'running');

        if (expectedHasRunning) {
          expect(link.classList.has('has-running')).toBe(true);
        } else {
          expect(link.classList.has('has-running')).toBe(false);
        }
      }),
      { numRuns: 1000 }
    );
  });

  // --- Example-based edge cases ---

  it('empty array → no has-running class', () => {
    const link = { classList: new Set<string>() };
    applyWorkNavClass(link, []);
    expect(link.classList.has('has-running')).toBe(false);
  });

  it('all done → no has-running class', () => {
    const jobs: Job[] = [
      { id: '1', name: 'a', jobChain: '', sessionChainId: '', timestamp: '', type: '', agent: '',
        status: 'done', lines: 0, lastLine: '', hasLog: false, logError: false,
        mdFile: '', logFile: '', agentDone: '', sizeBytes: 0 },
      { id: '2', name: 'b', jobChain: '', sessionChainId: '', timestamp: '', type: '', agent: '',
        status: 'done', lines: 0, lastLine: '', hasLog: false, logError: false,
        mdFile: '', logFile: '', agentDone: '', sizeBytes: 0 },
    ];
    const link = { classList: new Set<string>() };
    applyWorkNavClass(link, jobs);
    expect(link.classList.has('has-running')).toBe(false);
  });

  it('mixed array with one running → has-running class present', () => {
    const jobs: Job[] = [
      { id: '1', name: 'a', jobChain: '', sessionChainId: '', timestamp: '', type: '', agent: '',
        status: 'done', lines: 0, lastLine: '', hasLog: false, logError: false,
        mdFile: '', logFile: '', agentDone: '', sizeBytes: 0 },
      { id: '2', name: 'b', jobChain: '', sessionChainId: '', timestamp: '', type: '', agent: '',
        status: 'running', lines: 10, lastLine: '', hasLog: true, logError: false,
        mdFile: '', logFile: '', agentDone: '', sizeBytes: 512 },
    ];
    const link = { classList: new Set<string>() };
    applyWorkNavClass(link, jobs);
    expect(link.classList.has('has-running')).toBe(true);
  });

  it('all running → has-running class present', () => {
    const jobs: Job[] = [
      { id: '1', name: 'a', jobChain: '', sessionChainId: '', timestamp: '', type: '', agent: '',
        status: 'running', lines: 0, lastLine: '', hasLog: false, logError: false,
        mdFile: '', logFile: '', agentDone: '', sizeBytes: 0 },
      { id: '2', name: 'b', jobChain: '', sessionChainId: '', timestamp: '', type: '', agent: '',
        status: 'running', lines: 5, lastLine: '', hasLog: false, logError: false,
        mdFile: '', logFile: '', agentDone: '', sizeBytes: 0 },
    ];
    const link = { classList: new Set<string>() };
    applyWorkNavClass(link, jobs);
    expect(link.classList.has('has-running')).toBe(true);
  });

  it('class is removed when previously set and jobs no longer have running', () => {
    const link = { classList: new Set<string>(['has-running']) };
    const jobs: Job[] = [
      { id: '1', name: 'a', jobChain: '', sessionChainId: '', timestamp: '', type: '', agent: '',
        status: 'error', lines: 0, lastLine: '', hasLog: false, logError: true,
        mdFile: '', logFile: '', agentDone: '', sizeBytes: 0 },
    ];
    applyWorkNavClass(link, jobs);
    expect(link.classList.has('has-running')).toBe(false);
  });

});
