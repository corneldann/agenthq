import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

function positiveNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got: ${JSON.stringify(raw)}`);
  return n;
}

export interface AgentConfig {
  apiKey: string;
  model: string;
  fallbackModels: string[];
  name: string;
  systemPrompt: string;
  maxSteps: number;
  maxCost: number;
  sessionDir: string;
  sessionEnabled: boolean;
  outputMode: 'text' | 'json' | 'quiet';
}

const DEFAULTS: AgentConfig = {
  apiKey: '',
  // Primary free model: 1M context, agentic workloads, tool use
  model: 'openrouter/owl-alpha',
  // Fallback chain: free models first, paid (pareto-code) last resort
  fallbackModels: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',  // 1M context, free fallback
    'openai/gpt-oss-120b:free',                  // 131K context, free fallback
    'openrouter/pareto-code',                    // paid, last resort
  ],
  name: 'AgentHQ',
  systemPrompt: [
    'You are an expert analyst and developer working on the Scottish Water BE Carbon Tool performance optimisation engagement.',
    '',
    'Project root (cwd): {cwd}',
    '',
    'Key paths (all RELATIVE to project root):',
    '- PowerBI/extracted/current/         -- June 2026 model (TE2 folder extraction)',
    '- PowerBI/extracted/versions/2026-05-22/ -- May 2026 model',
    '- PowerBI/schema/current/vpax_extracted/ -- June VertiPaq (DaxVpaView.json etc)',
    '- PowerBI/schema/versions/2026-05-22/vpax_extracted/ -- May VertiPaq',
    '- docs/analysis/                     -- analysis output documents',
    '- docs/recommendations/              -- optimisation backlog',
    '- oracle/queries/                    -- Oracle SQL files',
    '- oracle/ddl/                        -- Index DDL',
    '',
    'CRITICAL PATH RULES — follow these exactly:',
    '- ALWAYS use RELATIVE paths with file_read, file_write, file_edit, glob, list_dir.',
    '  Correct:   docs/analysis/03-model-diff.md',
    '  Wrong:     C:\\Users\\Admin\\OneDrive - PBT Group\\Repos\\...\\docs\\analysis\\03-model-diff.md',
    '- NEVER construct absolute paths. The project root is {cwd} — all tools resolve relative paths from there.',
    '- When using the shell tool, use relative paths in commands too. The shell runs from {cwd} by default.',
    '- Do NOT write helper Python scripts to do what file_write can do directly.',
    '',
    'Guidelines:',
    '- Use your tools proactively. Read files before making claims about them.',
    '- Keep working until the task is fully resolved before responding.',
    '- Write output files to docs/analysis/ using RELATIVE paths.',
    '- When the prompt asks you to write a file, use file_write directly — do not write a script to do it.',
    '- Be concise in explanations, thorough in output files.',
  ].join('\n'),
  maxSteps: 30,
  maxCost: 0.50,
  sessionDir: '.sessions',
  sessionEnabled: true,
  outputMode: 'text',
};

export function loadConfig(overrides: Partial<AgentConfig> = {}, opts?: { skipApiKey?: boolean }): AgentConfig {
  let config = { ...DEFAULTS };

  const configPath = resolve(import.meta.dirname, '..', 'agent.config.json');
  if (existsSync(configPath)) {
    const file = JSON.parse(readFileSync(configPath, 'utf-8'));
    config = { ...config, ...file };
  }

  if (process.env.OPENROUTER_API_KEY) config.apiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.AGENT_MODEL)      config.model = process.env.AGENT_MODEL;
  if (process.env.AGENT_MAX_STEPS)  config.maxSteps = positiveNumber('AGENT_MAX_STEPS', process.env.AGENT_MAX_STEPS);
  if (process.env.AGENT_MAX_COST)   config.maxCost  = positiveNumber('AGENT_MAX_COST',  process.env.AGENT_MAX_COST);

  config = { ...config, ...overrides };
  if (!config.apiKey && !opts?.skipApiKey) throw new Error('OPENROUTER_API_KEY is required. Set it with: setx OPENROUTER_API_KEY your-key-here');
  return config;
}
