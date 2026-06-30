#!/usr/bin/env bun
import { parseArgs } from 'util';
import { readFileSync } from 'fs';
import { loadConfig } from './config.js';
import { runAgentWithRetry, type AgentEvent } from './agent.js';
import { initSessionDir, saveMessage, newSessionPath } from './session.js';

// ── Pre-scan for output mode so errors can be formatted correctly ──
const argv = Bun.argv.slice(2);
const preMode: 'text' | 'json' | 'quiet' =
  argv.includes('--json') || argv.includes('-j') ? 'json' :
  argv.includes('--quiet') || argv.includes('-q') ? 'quiet' : 'text';

function reportError(err: any): never {
  const message = err?.message ?? String(err);
  if (preMode === 'json') process.stdout.write(JSON.stringify({ type: 'error', message }) + '\n');
  else if (preMode !== 'quiet') process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

// ── Argument parsing ───────────────────────────────────────────────
let values: Record<string, any>;
let positionals: string[];
try {
  const parsed = parseArgs({
    args: argv,
    options: {
      prompt:           { type: 'string',  short: 'p' },
      json:             { type: 'boolean', short: 'j', default: false },
      quiet:            { type: 'boolean', short: 'q', default: false },
      'no-session':     { type: 'boolean', default: false },
      model:            { type: 'string',  short: 'm' },
      'max-steps':      { type: 'string' },
      'max-cost':       { type: 'string' },
      'output-schema':  { type: 'string' },
      'show-tools':     { type: 'boolean', default: false },
      help:             { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  values = parsed.values;
  positionals = parsed.positionals;
} catch (err) {
  reportError(err);
}

// ── Help ───────────────────────────────────────────────────────────
if (values.help) {
  console.log(`Usage: agenthq [options] [prompt]

Options:
  -p, --prompt <text>       Prompt to send to the agent
  -j, --json                Output NDJSON event stream instead of text
  -q, --quiet               No output; exit 0 on success, 1 on error
      --no-session          Disable session persistence for this run
  -m, --model <model>       Override the model (e.g. openrouter/owl-alpha)
      --max-steps <n>       Maximum number of agent steps (default: 30)
      --max-cost <n>        Maximum cost in dollars (default: 0.50)
      --output-schema <f>   Path to a JSON Schema file to validate output
      --show-tools          Print tool calls to stderr as they execute
  -h, --help                Show this help message

Prompt sources (priority order):
  1. --prompt flag
  2. Positional argument
  3. Piped stdin (when stdin is not a TTY)

Examples:
  agenthq "What tables are in the June model?"
  cat docs/analysis/prompts/prompt-13-model-diff-and-vertiPaq.md | agenthq agenthq --json -p "Summarise the VertiPaq analysis" | jq .
  agenthq -m anthropic/claude-sonnet-4.5 -p "Review the optimisation backlog"
`);
  process.exit(0);
}

// ── Resolve prompt ─────────────────────────────────────────────────
let prompt = values.prompt ?? positionals[0];

if (!prompt && !process.stdin.isTTY) {
  prompt = await Bun.stdin.text();
  prompt = prompt.trim();
}

if (!prompt) {
  process.stderr.write('Error: no prompt provided. Use --prompt, a positional arg, or pipe to stdin.\n');
  process.exit(1);
}

// ── Load config with CLI overrides ────────────────────────────────
let config;
try {
  config = loadConfig();
} catch (err) {
  reportError(err);
}

if (values.model) config.model = values.model;
if (values['max-steps']) {
  const n = Number(values['max-steps']);
  if (!Number.isFinite(n) || n <= 0) reportError(new Error(`--max-steps must be a positive number, got: ${values['max-steps']}`));
  config.maxSteps = n;
}
if (values['max-cost']) {
  const n = Number(values['max-cost']);
  if (!Number.isFinite(n) || n <= 0) reportError(new Error(`--max-cost must be a positive number, got: ${values['max-cost']}`));
  config.maxCost = n;
}

// ── Load output schema (optional) ─────────────────────────────────
let outputSchema: Record<string, unknown> | undefined;
if (values['output-schema']) {
  try {
    const raw = readFileSync(values['output-schema'], 'utf-8');
    outputSchema = JSON.parse(raw);
  } catch (err: any) {
    reportError(new Error(`Could not load output schema: ${err.message}`));
  }
}

// ── Session setup ──────────────────────────────────────────────────
let sessionPath: string | undefined;
if (config.sessionEnabled && !values['no-session']) {
  initSessionDir(config.sessionDir);
  sessionPath = newSessionPath(config.sessionDir);
  saveMessage(sessionPath, { role: 'user', content: prompt });
}

// ── Run agent ──────────────────────────────────────────────────────
try {
  let hasEmittedText = false;

  const result = await runAgentWithRetry(config, prompt, {
    onEvent: (event: AgentEvent) => {
      if (values.json) {
        process.stdout.write(JSON.stringify(event) + '\n');
      } else if (!values.quiet) {
        if (event.type === 'text') {
          process.stdout.write(event.delta);
          hasEmittedText = true;
        } else if (event.type === 'turn_end' && hasEmittedText) {
          process.stdout.write('\n');
        } else if (event.type === 'tool_call' && values['show-tools']) {
          process.stderr.write(`[tool] ${event.name}(${JSON.stringify(event.args).slice(0, 120)})\n`);
        } else if (event.type === 'done') {
          const u = event.usage;
          if (u) {
            const tokens = u.totalTokens ?? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0));
            process.stderr.write(`[agenthq] done in ${(event.durationMs / 1000).toFixed(1)}s, ~${tokens} tokens\n`);
          }
        }
      }
    },
  });

  // Ensure output ends with a newline in text mode
  if (!values.json && !values.quiet) {
    process.stdout.write('\n');
  }

  // Persist assistant response
  if (sessionPath) {
    saveMessage(sessionPath, { role: 'assistant', content: result.text });
  }

  // Validate output schema if requested
  if (outputSchema) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — ajv is an optional dep; install with: bun add ajv
    const { default: Ajv } = await import('ajv');
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(outputSchema);

    const extractJson = (text: string): string => {
      const trimmed = text.trim();
      const fence = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (fence) return fence[1].trim();
      const objStart = trimmed.indexOf('{');
      const objEnd = trimmed.lastIndexOf('}');
      const arrStart = trimmed.indexOf('[');
      const arrEnd = trimmed.lastIndexOf(']');
      const useArr = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
      const start = useArr ? arrStart : objStart;
      const end = useArr ? arrEnd : objEnd;
      if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
      return trimmed;
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(result.text));
    } catch {
      process.stderr.write('Error: agent output is not valid JSON (output-schema was specified)\n');
      process.exit(2);
    }
    if (!validate(parsed)) {
      process.stderr.write(`Error: output failed schema validation: ${ajv.errorsText(validate.errors)}\n`);
      process.exit(2);
    }
  }

  process.exit(0);
} catch (err: any) {
  if (!values.quiet) {
    if (values.json) {
      process.stdout.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
    } else {
      process.stderr.write(`Error: ${err.message}\n`);
    }
  }
  process.exit(1);
}
