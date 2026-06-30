// ---------------------------------------------------------------------------
// Domain interfaces and type aliases — single authoritative source.
// This file contains ONLY export interface / export type declarations.
// No logic, no functions, no runtime imports.
// ---------------------------------------------------------------------------

export interface Job {
  id: string;
  name: string;
  jobChain: string;       // grouping key = job name slug (e.g. "summarise-tooling-and-project")
  sessionChainId: string; // session chain this job belongs to (extracted from source path)
  timestamp: string;
  type: string;
  agent: string;
  status: "running" | "done" | "reported" | "error";
  lines: number;
  lastLine: string;
  hasLog: boolean;
  logError: boolean;
  mdFile: string;
  logFile: string;
  agentDone: string;
  sizeBytes: number;
}

export interface SessionState {
  workflowHash: string;
  sessionJsonl: string;
  chainId: string;
  chainIndex: number;
  previousSession: string;
  topic: string;
  messageCount: number;
  userMessageCount: number;
  contextUsagePct: number;
  lastMessageAt: string;
  lastSummarisedMessageCount: number;
  lastSummarisedAt: string;
  summaryFile: string;
  status: "active" | "idle" | "complete" | "rate-limited";
  firstUserMessage: string;
  lastUserMessage: string;
  lastAgentMessage: string;
  startTime: string;
  /** Unique Kiro chat-session identifier — used to deduplicate multi-snapshot sessions. */
  chatSessionId?: string;
}

export interface Chain {
  chainId: string;
  displayName: string;
  nextIndex: number;
  sessions: Array<{
    index: number;
    workflowHash: string;
    date: string;
    messageCount: number;
    status: string;
  }>;
  totalMessages: number;
  createdAt: string;
  lastActiveAt: string;
  // computed
  latestSession?: SessionState;
  unsummarisedDelta?: number;
  overallStatus?: string;
  workflowCount?: number;  // raw snapshot count before dedup
  specChainId?: string;    // set when this chain is absorbed into a spec chain
}

export interface JobChain {
  jobChain: string;        // name slug — the grouping key
  sessionChainId: string;  // linked session chain
  type: string;            // most common job type
  latestStatus: string;    // status of most recent run
  latestTimestamp: string;
  runCount: number;
  runs: Job[];             // all runs, newest first
}

export interface PollLogEntry {
  ts: number;           // Unix ms
  type: "CRAWL" | "CLONE" | "PROMPT" | "poll";
  count: number;        // items dispatched (0 for idle poll)
  detail: string;       // human-readable detail
  workflowHash: string; // source workflow file
}

export interface BackgroundJobRecord {
  stem: string;          // e.g. "2026-06-25-1823-crawl-9"
  type: "crawl" | "clone";
  ts: number;            // ms since epoch
  chainId: string;       // session chain that triggered this job (empty = standalone)
  count: number;         // number of URLs/repos
  detail: string;        // comma-separated URLs or repo names
  status: "done" | "running" | "error";
}

export interface BuildQueueRecord {
  target: "dashboard";   // what to build
  ts: number;            // Date.now() when queued
  status: "pending" | "building" | "done" | "error";
  stem: string;          // e.g. "2026-06-26-1800-build-dashboard"
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  modified: string[];
  staged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}

export interface GitCommitResult {
  jobStem: string;
}

export type SSEController = { enqueue: (data: string) => void; closed: boolean };
