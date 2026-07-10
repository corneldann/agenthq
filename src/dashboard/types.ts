// types.ts — all shared TypeScript interfaces and type aliases
// Feature: monitor-dashboard-redesign, multi-workspace-monitoring

// Job — mirrors server-side Job interface in monitor.ts exactly
export interface Job {
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
  workspaceId: string;
}

// SessionState — mirrors server-side SessionState interface in monitor.ts
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
  status: 'active' | 'idle' | 'complete' | 'rate-limited';
  firstUserMessage: string;
  lastUserMessage: string;
  lastAgentMessage: string;
  startTime: string;
  workspaceId: string;
}

// Chain — mirrors server-side Chain interface in monitor.ts exactly
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
  latestSession?: SessionState;
  unsummarisedDelta?: number;
  overallStatus?: string;
  workflowCount?: number;
  specChainId?: string;    // set when this chain is absorbed into a spec umbrella chain
  workspaceId: string;
}

// JobChain — mirrors server-side JobChain interface in monitor.ts exactly
export interface JobChain {
  jobChain: string;
  sessionChainId: string;
  type: string;
  latestStatus: string;
  latestTimestamp: string;
  runCount: number;
  runs: Job[];
  workspaceId: string;
}

// PollLogEntry — mirrors server-side PollLogEntry interface in monitor.ts exactly
export interface PollLogEntry {
  ts: number;
  type: 'CRAWL' | 'CLONE' | 'PROMPT' | 'poll';
  count: number;
  detail: string;
  workflowHash: string;
}

// SystemStatus — returned by GET /system-status
export interface SystemStatus {
  sseClients: number;
  processedCount: number;
  lastPollTime: number;
  lastPollAgo: number | null;
  uptime: number;
  workflowDirOk: boolean;
}

// GitStatus — returned by new GET /git-status endpoint
export interface GitStatus {
  branch: string;
  clean: boolean;
  modified: string[];
  staged: string[];
  untracked: string[];
  ahead: number;
  behind: number;
  workspaceId: string;
}

export type CommitState = null | 'running' | 'done' | 'error';

export type Page = 'dashboard' | 'work' | 'activity';

// BuildQueueRecord — mirrors server-side BuildQueueRecord interface
// Requirement 3.8 (workspaceId field), Requirement 8.8 (display in dashboard)
export interface BuildQueueRecord {
  target: 'dashboard';
  ts: number;
  status: 'pending' | 'building' | 'done' | 'error';
  stem: string;
  workspaceId: string;
}

// WorkspaceFilterState — tracks workspace selector state
// Requirements: 6.8, 6.9, 6.10, 6.11
export interface WorkspaceFilterState {
  /** null means "All Workspaces" is selected */
  selectedWorkspaceId: string | null;
  availableWorkspaces: { id: string; displayName: string }[];
}

// SSEUpdateEvent — structured SSE event payload with workspace identification
// Requirements: 11.2, 11.3, 11.4, 11.5
export interface SSEUpdateEvent {
  type: 'chain-update' | 'job-update' | 'session-update' | 'git-update';
  workspaceId?: string | null;
  data?: Chain | Job | SessionState | GitStatus;
}

export interface Toast {
  id: string;          // unique UUID
  type: 'success' | 'error';
  message: string;
  persistent: boolean; // true for error toasts
}

// WorkspaceMetrics — per-workspace activity summary for comparison table
// Requirements: 10.1, 10.2, 10.3, 10.4
export interface WorkspaceMetrics {
  workspaceId: string;
  displayName: string;
  totalMessages: number;
  contextUsagePct: number;
  activeSessions: number;
  pendingQueueItems: number;
  hasAttentionItems: boolean; // unsummarised sessions or queue errors
}

// AppState — the single observable application state
export interface AppState {
  chains: Chain[];
  jobChains: JobChain[];
  jobs: Job[];
  pollLog: PollLogEntry[];
  systemStatus: SystemStatus | null;
  gitStatus: GitStatus | null;
  /** Multi-workspace git statuses — populated when multiple workspaces configured */
  gitStatuses: GitStatus[];
  /** Build queue records — populated from /build-queue endpoint (Requirement 8.8) */
  buildQueue: BuildQueueRecord[];
  summariseStatus: Record<string, 'queued' | 'done' | 'error'>;
  hiddenChains: Record<string, boolean>;
  currentPage: Page;
  drawerChainId: string | null;
  commitState: CommitState;
  toasts: Toast[];
  workspaceFilter: WorkspaceFilterState;
}
