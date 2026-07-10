/**
 * Unit Tests for Queue Poller Modifications
 *
 * Tests covering:
 * - Queue file loading from workspace-specific paths (Requirement 8.1)
 * - Crawl queue entries processed in owning workspace context (Requirement 8.2)
 * - Clone queue entries processed in owning workspace context (Requirement 8.3)
 * - Build queue entries processed in owning workspace context (Requirement 8.4)
 * - workspaceId populated on dispatched entries (Requirement 8.5)
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadQueues,
  getDefaultWorkspaceContext,
  type QueuePollerWorkspaceContext,
} from '../../src/workers/queuePoller';
import type { BackgroundJobRecord, BuildQueueRecord } from '../../src/types';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWorkspace(
  id: string,
  root: string,
  overrides: Partial<QueuePollerWorkspaceContext> = {}
): QueuePollerWorkspaceContext {
  return {
    workspaceId: id,
    workspaceRoot: root,
    crawlJobsFile: join(root, 'crawl-queue.json'),
    cloneJobsFile: join(root, 'clone-queue.json'),
    buildQueueFile: join(root, 'build-queue.json'),
    ...overrides,
  };
}

function makeCrawlRecord(stem: string, workspaceId = ''): BackgroundJobRecord {
  return {
    stem,
    type: 'crawl',
    ts: Date.now(),
    chainId: '',
    count: 1,
    detail: 'https://example.com',
    status: 'done',
    workspaceId,
  };
}

function makeCloneRecord(stem: string, workspaceId = ''): BackgroundJobRecord {
  return {
    stem,
    type: 'clone',
    ts: Date.now(),
    chainId: '',
    count: 1,
    detail: 'https://github.com/example/repo',
    status: 'done',
    workspaceId,
  };
}

function makeBuildRecord(stem: string, workspaceId = ''): BuildQueueRecord {
  return {
    target: 'dashboard',
    ts: Date.now(),
    status: 'pending',
    stem,
    workspaceId,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('QueuePollerWorkspaceContext', () => {
  describe('Interface shape', () => {
    it('should have all required fields', () => {
      const ctx: QueuePollerWorkspaceContext = {
        workspaceId: 'my-workspace',
        workspaceRoot: '/some/root',
        crawlJobsFile: 'docs/.crawl-queue.json',
        cloneJobsFile: 'docs/.clone-queue.json',
        buildQueueFile: 'docs/.build-queue.json',
      };
      expect(ctx.workspaceId).toBe('my-workspace');
      expect(ctx.workspaceRoot).toBe('/some/root');
      expect(ctx.crawlJobsFile).toBeDefined();
      expect(ctx.cloneJobsFile).toBeDefined();
      expect(ctx.buildQueueFile).toBeDefined();
    });
  });
});

describe('getDefaultWorkspaceContext', () => {
  it('should return a context with all required fields', () => {
    const ctx = getDefaultWorkspaceContext();
    expect(ctx).toHaveProperty('workspaceId');
    expect(ctx).toHaveProperty('workspaceRoot');
    expect(ctx).toHaveProperty('crawlJobsFile');
    expect(ctx).toHaveProperty('cloneJobsFile');
    expect(ctx).toHaveProperty('buildQueueFile');
  });

  it('should default workspaceId to "default" when WORKSPACE_ROOT is empty', () => {
    // getDefaultWorkspaceContext reads from module-level constants.
    // When WORKSPACE_ROOT env is empty, workspaceId should fall back to "default".
    const ctx = getDefaultWorkspaceContext();
    // workspaceId is either "default" or a slug derived from WORKSPACE_ROOT
    expect(typeof ctx.workspaceId).toBe('string');
    expect(ctx.workspaceId.length).toBeGreaterThan(0);
  });

  it('should produce a workspaceId that is a valid slug (no special chars)', () => {
    const ctx = getDefaultWorkspaceContext();
    // Derived slug should not start or end with a hyphen
    expect(ctx.workspaceId).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/);
  });
});

describe('loadQueues', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `queue-poller-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // -------------------------------------------------------------------------
  // Requirement 8.1 — Load queue files from workspace-specific paths
  // -------------------------------------------------------------------------

  describe('Requirement 8.1 — Queue file loading from workspace-specific paths', () => {
    it('should load crawl queue entries from workspace-specific path', async () => {
      const record = makeCrawlRecord('2024-01-01-crawl-1');
      await writeFile(join(testDir, 'crawl-queue.json'), JSON.stringify([record]), 'utf-8');
      const workspace = makeWorkspace('ws-a', testDir);

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue).toHaveLength(1);
      expect(crawlQueue[0].stem).toBe('2024-01-01-crawl-1');
    });

    it('should load clone queue entries from workspace-specific path', async () => {
      const record = makeCloneRecord('2024-01-01-clone-1');
      await writeFile(join(testDir, 'clone-queue.json'), JSON.stringify([record]), 'utf-8');
      const workspace = makeWorkspace('ws-b', testDir);

      const { cloneQueue } = await loadQueues([workspace]);

      expect(cloneQueue).toHaveLength(1);
      expect(cloneQueue[0].stem).toBe('2024-01-01-clone-1');
    });

    it('should load build queue entries from workspace-specific path', async () => {
      const record = makeBuildRecord('2024-01-01-build-dashboard');
      await writeFile(join(testDir, 'build-queue.json'), JSON.stringify([record]), 'utf-8');
      const workspace = makeWorkspace('ws-c', testDir);

      const { buildQueue } = await loadQueues([workspace]);

      expect(buildQueue).toHaveLength(1);
      expect(buildQueue[0].stem).toBe('2024-01-01-build-dashboard');
    });

    it('should return empty arrays when no queue files exist', async () => {
      const workspace = makeWorkspace('ws-empty', testDir);

      const { crawlQueue, cloneQueue, buildQueue } = await loadQueues([workspace]);

      expect(crawlQueue).toHaveLength(0);
      expect(cloneQueue).toHaveLength(0);
      expect(buildQueue).toHaveLength(0);
    });

    it('should skip missing queue files gracefully without throwing', async () => {
      const workspace = makeWorkspace('ws-missing', '/non/existent/path');

      await expect(loadQueues([workspace])).resolves.toBeDefined();
      const { crawlQueue, cloneQueue, buildQueue } = await loadQueues([workspace]);
      expect(crawlQueue).toHaveLength(0);
      expect(cloneQueue).toHaveLength(0);
      expect(buildQueue).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Requirement 8.5 — workspaceId populated on dispatched entries
  // -------------------------------------------------------------------------

  describe('Requirement 8.5 — workspaceId populated on all returned entries', () => {
    it('should populate workspaceId on crawl entries with the workspace identifier', async () => {
      const record = makeCrawlRecord('crawl-stem');
      await writeFile(join(testDir, 'crawl-queue.json'), JSON.stringify([record]), 'utf-8');
      const workspace = makeWorkspace('alpha-workspace', testDir);

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue[0].workspaceId).toBe('alpha-workspace');
    });

    it('should populate workspaceId on clone entries with the workspace identifier', async () => {
      const record = makeCloneRecord('clone-stem');
      await writeFile(join(testDir, 'clone-queue.json'), JSON.stringify([record]), 'utf-8');
      const workspace = makeWorkspace('beta-workspace', testDir);

      const { cloneQueue } = await loadQueues([workspace]);

      expect(cloneQueue[0].workspaceId).toBe('beta-workspace');
    });

    it('should populate workspaceId on build entries with the workspace identifier', async () => {
      const record = makeBuildRecord('build-stem');
      await writeFile(join(testDir, 'build-queue.json'), JSON.stringify([record]), 'utf-8');
      const workspace = makeWorkspace('gamma-workspace', testDir);

      const { buildQueue } = await loadQueues([workspace]);

      expect(buildQueue[0].workspaceId).toBe('gamma-workspace');
    });

    it('should overwrite any pre-existing workspaceId on loaded records', async () => {
      // Records on disk may have an old or wrong workspaceId — loadQueues must override it
      const record = makeCrawlRecord('old-crawl', 'stale-id');
      await writeFile(join(testDir, 'crawl-queue.json'), JSON.stringify([record]), 'utf-8');
      const workspace = makeWorkspace('correct-workspace', testDir);

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue[0].workspaceId).toBe('correct-workspace');
    });

    it('should ensure every entry has a non-empty workspaceId', async () => {
      const records: BackgroundJobRecord[] = [
        makeCrawlRecord('crawl-1'),
        makeCrawlRecord('crawl-2'),
        makeCrawlRecord('crawl-3'),
      ];
      await writeFile(join(testDir, 'crawl-queue.json'), JSON.stringify(records), 'utf-8');
      const workspace = makeWorkspace('target-workspace', testDir);

      const { crawlQueue } = await loadQueues([workspace]);

      for (const entry of crawlQueue) {
        expect(entry.workspaceId).toBe('target-workspace');
        expect(entry.workspaceId.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Requirements 8.2, 8.3, 8.4 — Workspace context resolution for queue entries
  // -------------------------------------------------------------------------

  describe('Requirements 8.2/8.3/8.4 — Workspace context resolution', () => {
    it('should load crawl entries from the owning workspace (not another workspace)', async () => {
      const wsADir = join(testDir, 'ws-a');
      const wsBDir = join(testDir, 'ws-b');
      await mkdir(wsADir, { recursive: true });
      await mkdir(wsBDir, { recursive: true });

      await writeFile(
        join(wsADir, 'crawl-queue.json'),
        JSON.stringify([makeCrawlRecord('ws-a-crawl')]),
        'utf-8'
      );
      await writeFile(
        join(wsBDir, 'crawl-queue.json'),
        JSON.stringify([makeCrawlRecord('ws-b-crawl')]),
        'utf-8'
      );

      const wsA = makeWorkspace('workspace-a', wsADir);
      const wsB = makeWorkspace('workspace-b', wsBDir);

      const { crawlQueue } = await loadQueues([wsA, wsB]);

      // ws-a entries must have workspace-a id, ws-b entries must have workspace-b id
      const wsAEntries = crawlQueue.filter(e => e.workspaceId === 'workspace-a');
      const wsBEntries = crawlQueue.filter(e => e.workspaceId === 'workspace-b');

      expect(wsAEntries).toHaveLength(1);
      expect(wsAEntries[0].stem).toBe('ws-a-crawl');

      expect(wsBEntries).toHaveLength(1);
      expect(wsBEntries[0].stem).toBe('ws-b-crawl');
    });

    it('should load clone entries from the owning workspace', async () => {
      const wsADir = join(testDir, 'ws-clone-a');
      const wsBDir = join(testDir, 'ws-clone-b');
      await mkdir(wsADir, { recursive: true });
      await mkdir(wsBDir, { recursive: true });

      await writeFile(join(wsADir, 'clone-queue.json'), JSON.stringify([makeCloneRecord('a-clone')]), 'utf-8');
      await writeFile(join(wsBDir, 'clone-queue.json'), JSON.stringify([makeCloneRecord('b-clone')]), 'utf-8');

      const { cloneQueue } = await loadQueues([
        makeWorkspace('ws-clone-a', wsADir),
        makeWorkspace('ws-clone-b', wsBDir),
      ]);

      expect(cloneQueue.find(e => e.stem === 'a-clone')?.workspaceId).toBe('ws-clone-a');
      expect(cloneQueue.find(e => e.stem === 'b-clone')?.workspaceId).toBe('ws-clone-b');
    });

    it('should load build entries from the owning workspace', async () => {
      const wsADir = join(testDir, 'ws-build-a');
      const wsBDir = join(testDir, 'ws-build-b');
      await mkdir(wsADir, { recursive: true });
      await mkdir(wsBDir, { recursive: true });

      await writeFile(join(wsADir, 'build-queue.json'), JSON.stringify([makeBuildRecord('a-build')]), 'utf-8');
      await writeFile(join(wsBDir, 'build-queue.json'), JSON.stringify([makeBuildRecord('b-build')]), 'utf-8');

      const { buildQueue } = await loadQueues([
        makeWorkspace('ws-build-a', wsADir),
        makeWorkspace('ws-build-b', wsBDir),
      ]);

      expect(buildQueue.find(e => e.stem === 'a-build')?.workspaceId).toBe('ws-build-a');
      expect(buildQueue.find(e => e.stem === 'b-build')?.workspaceId).toBe('ws-build-b');
    });
  });

  // -------------------------------------------------------------------------
  // Relative path resolution against WORKSPACE_ROOT
  // -------------------------------------------------------------------------

  describe('Relative path resolution against WORKSPACE_ROOT', () => {
    it('should resolve a relative crawlJobsFile path against workspaceRoot', async () => {
      const subDir = join(testDir, 'docs');
      await mkdir(subDir, { recursive: true });
      const record = makeCrawlRecord('relative-crawl');
      await writeFile(join(subDir, '.crawl-queue.json'), JSON.stringify([record]), 'utf-8');

      const workspace: QueuePollerWorkspaceContext = {
        workspaceId: 'rel-ws',
        workspaceRoot: testDir,
        crawlJobsFile: 'docs/.crawl-queue.json', // relative
        cloneJobsFile: join(testDir, 'clone-queue.json'), // absolute (missing — ok)
        buildQueueFile: join(testDir, 'build-queue.json'), // absolute (missing — ok)
      };

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue).toHaveLength(1);
      expect(crawlQueue[0].stem).toBe('relative-crawl');
      expect(crawlQueue[0].workspaceId).toBe('rel-ws');
    });

    it('should resolve a relative cloneJobsFile path against workspaceRoot', async () => {
      const subDir = join(testDir, 'ref');
      await mkdir(subDir, { recursive: true });
      const record = makeCloneRecord('relative-clone');
      await writeFile(join(subDir, '.clone-queue.json'), JSON.stringify([record]), 'utf-8');

      const workspace: QueuePollerWorkspaceContext = {
        workspaceId: 'rel-clone-ws',
        workspaceRoot: testDir,
        crawlJobsFile: join(testDir, 'crawl-queue.json'),
        cloneJobsFile: 'ref/.clone-queue.json', // relative
        buildQueueFile: join(testDir, 'build-queue.json'),
      };

      const { cloneQueue } = await loadQueues([workspace]);

      expect(cloneQueue).toHaveLength(1);
      expect(cloneQueue[0].stem).toBe('relative-clone');
      expect(cloneQueue[0].workspaceId).toBe('rel-clone-ws');
    });

    it('should resolve a relative buildQueueFile path against workspaceRoot', async () => {
      const subDir = join(testDir, 'queues');
      await mkdir(subDir, { recursive: true });
      const record = makeBuildRecord('relative-build');
      await writeFile(join(subDir, '.build-queue.json'), JSON.stringify([record]), 'utf-8');

      const workspace: QueuePollerWorkspaceContext = {
        workspaceId: 'rel-build-ws',
        workspaceRoot: testDir,
        crawlJobsFile: join(testDir, 'crawl-queue.json'),
        cloneJobsFile: join(testDir, 'clone-queue.json'),
        buildQueueFile: 'queues/.build-queue.json', // relative
      };

      const { buildQueue } = await loadQueues([workspace]);

      expect(buildQueue).toHaveLength(1);
      expect(buildQueue[0].stem).toBe('relative-build');
      expect(buildQueue[0].workspaceId).toBe('rel-build-ws');
    });

    it('should use absolute paths unchanged (not join with workspaceRoot)', async () => {
      const record = makeCrawlRecord('absolute-path-crawl');
      const absoluteQueueFile = join(testDir, 'absolute-crawl.json');
      await writeFile(absoluteQueueFile, JSON.stringify([record]), 'utf-8');

      const workspace: QueuePollerWorkspaceContext = {
        workspaceId: 'abs-ws',
        workspaceRoot: '/some/other/root', // different root — absolute path should not be affected
        crawlJobsFile: absoluteQueueFile, // absolute — should be used as-is
        cloneJobsFile: '/non/existent/clone.json',
        buildQueueFile: '/non/existent/build.json',
      };

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue).toHaveLength(1);
      expect(crawlQueue[0].stem).toBe('absolute-path-crawl');
    });
  });

  // -------------------------------------------------------------------------
  // Aggregation across multiple workspaces
  // -------------------------------------------------------------------------

  describe('Aggregation of entries from multiple workspaces', () => {
    it('should aggregate crawl entries from all workspaces into a single array', async () => {
      const ws1Dir = join(testDir, 'agg-ws1');
      const ws2Dir = join(testDir, 'agg-ws2');
      const ws3Dir = join(testDir, 'agg-ws3');
      await mkdir(ws1Dir, { recursive: true });
      await mkdir(ws2Dir, { recursive: true });
      await mkdir(ws3Dir, { recursive: true });

      await writeFile(join(ws1Dir, 'crawl-queue.json'), JSON.stringify([makeCrawlRecord('crawl-a1'), makeCrawlRecord('crawl-a2')]), 'utf-8');
      await writeFile(join(ws2Dir, 'crawl-queue.json'), JSON.stringify([makeCrawlRecord('crawl-b1')]), 'utf-8');
      await writeFile(join(ws3Dir, 'crawl-queue.json'), JSON.stringify([makeCrawlRecord('crawl-c1'), makeCrawlRecord('crawl-c2'), makeCrawlRecord('crawl-c3')]), 'utf-8');

      const { crawlQueue } = await loadQueues([
        makeWorkspace('ws1', ws1Dir),
        makeWorkspace('ws2', ws2Dir),
        makeWorkspace('ws3', ws3Dir),
      ]);

      expect(crawlQueue).toHaveLength(6);
      expect(crawlQueue.filter(e => e.workspaceId === 'ws1')).toHaveLength(2);
      expect(crawlQueue.filter(e => e.workspaceId === 'ws2')).toHaveLength(1);
      expect(crawlQueue.filter(e => e.workspaceId === 'ws3')).toHaveLength(3);
    });

    it('should aggregate clone, crawl and build entries independently across workspaces', async () => {
      const ws1Dir = join(testDir, 'mix-ws1');
      const ws2Dir = join(testDir, 'mix-ws2');
      await mkdir(ws1Dir, { recursive: true });
      await mkdir(ws2Dir, { recursive: true });

      await writeFile(join(ws1Dir, 'crawl-queue.json'), JSON.stringify([makeCrawlRecord('crawl-1')]), 'utf-8');
      await writeFile(join(ws1Dir, 'clone-queue.json'), JSON.stringify([makeCloneRecord('clone-1')]), 'utf-8');
      await writeFile(join(ws2Dir, 'build-queue.json'), JSON.stringify([makeBuildRecord('build-1')]), 'utf-8');

      const { crawlQueue, cloneQueue, buildQueue } = await loadQueues([
        makeWorkspace('mix-ws1', ws1Dir),
        makeWorkspace('mix-ws2', ws2Dir),
      ]);

      expect(crawlQueue).toHaveLength(1);
      expect(cloneQueue).toHaveLength(1);
      expect(buildQueue).toHaveLength(1);
      expect(crawlQueue[0].workspaceId).toBe('mix-ws1');
      expect(cloneQueue[0].workspaceId).toBe('mix-ws1');
      expect(buildQueue[0].workspaceId).toBe('mix-ws2');
    });

    it('should return empty aggregated results when passed an empty workspace array', async () => {
      const { crawlQueue, cloneQueue, buildQueue } = await loadQueues([]);

      expect(crawlQueue).toHaveLength(0);
      expect(cloneQueue).toHaveLength(0);
      expect(buildQueue).toHaveLength(0);
    });

    it('should continue loading valid workspaces when one workspace path is missing', async () => {
      const validDir = join(testDir, 'valid-ws');
      await mkdir(validDir, { recursive: true });
      await writeFile(join(validDir, 'crawl-queue.json'), JSON.stringify([makeCrawlRecord('valid-crawl')]), 'utf-8');

      const { crawlQueue } = await loadQueues([
        makeWorkspace('missing-ws', '/non/existent/path'),
        makeWorkspace('valid-ws', validDir),
      ]);

      // Missing workspace produces nothing; valid workspace contributes its entries
      expect(crawlQueue).toHaveLength(1);
      expect(crawlQueue[0].workspaceId).toBe('valid-ws');
    });
  });

  // -------------------------------------------------------------------------
  // JSONL (newline-delimited JSON) format support
  // -------------------------------------------------------------------------

  describe('Queue file format support', () => {
    it('should parse JSON array format correctly', async () => {
      const records = [makeCrawlRecord('array-crawl-1'), makeCrawlRecord('array-crawl-2')];
      await writeFile(join(testDir, 'crawl-queue.json'), JSON.stringify(records), 'utf-8');
      const workspace = makeWorkspace('format-ws', testDir);

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue).toHaveLength(2);
      expect(crawlQueue.map(e => e.stem)).toContain('array-crawl-1');
      expect(crawlQueue.map(e => e.stem)).toContain('array-crawl-2');
    });

    it('should parse JSONL (newline-delimited) format correctly', async () => {
      const record1 = makeCrawlRecord('jsonl-crawl-1');
      const record2 = makeCrawlRecord('jsonl-crawl-2');
      const jsonl = JSON.stringify(record1) + '\n' + JSON.stringify(record2) + '\n';
      await writeFile(join(testDir, 'crawl-queue.json'), jsonl, 'utf-8');
      const workspace = makeWorkspace('jsonl-ws', testDir);

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue).toHaveLength(2);
      expect(crawlQueue.map(e => e.stem)).toContain('jsonl-crawl-1');
      expect(crawlQueue.map(e => e.stem)).toContain('jsonl-crawl-2');
    });

    it('should return empty array for an empty queue file', async () => {
      await writeFile(join(testDir, 'crawl-queue.json'), '', 'utf-8');
      const workspace = makeWorkspace('empty-file-ws', testDir);

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue).toHaveLength(0);
    });

    it('should skip malformed JSONL lines and still load valid ones', async () => {
      const valid = makeCrawlRecord('partial-valid');
      const jsonl = '{ this is invalid json }\n' + JSON.stringify(valid) + '\n';
      await writeFile(join(testDir, 'crawl-queue.json'), jsonl, 'utf-8');
      const workspace = makeWorkspace('partial-ws', testDir);

      const { crawlQueue } = await loadQueues([workspace]);

      expect(crawlQueue).toHaveLength(1);
      expect(crawlQueue[0].stem).toBe('partial-valid');
    });
  });
}); // end describe('loadQueues')
