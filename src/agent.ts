import { OpenRouter } from '@openrouter/agent';
import type { Item } from '@openrouter/agent';
import { stepCountIs, maxCost } from '@openrouter/agent/stop-conditions';
import type { AgentConfig } from './config.js';
import { tools } from './tools/index.js';
import type { Job } from './types.js';
import type { IMemoryClient } from './memory/types.js';
import { assembleContext } from './memory/assembly.js';
import {
  MEMORY_ENABLED,
  MEMORY_AUTO_INJECT,
  MEMORY_MAX_CONTEXT_MEMORIES,
  MEMORY_CONTEXT_TOKEN_BUDGET,
} from './constants.js';

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; callId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; callId: string; output: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'turn_end' }
  | { type: 'done'; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null | undefined; durationMs: number };

/**
 * Build system prompt with optional memory context injection.
 * 
 * When MEMORY_ENABLED=false: returns basePrompt immediately with no call.
 * When MEMORY_ENABLED=true: calls assembleContext with 450ms timeout guard.
 * When MEMORY_AUTO_INJECT=false: logs result at DEBUG but does not append.
 * When MEMORY_AUTO_INJECT=true and non-empty result: appends memory block.
 * 
 * @param basePrompt - Base system prompt before memory injection
 * @param job - Optional job for memory context assembly
 * @param memoryClient - Optional memory client for recall
 * @returns System prompt with or without memory context
 */
async function buildPromptWithMemory(
  basePrompt: string,
  job?: Job,
  memoryClient?: IMemoryClient,
): Promise<string> {
  // Skip entirely when memory is disabled
  if (!MEMORY_ENABLED) {
    return basePrompt;
  }

  // Skip if job or client not provided (no context to assemble)
  if (job === undefined || memoryClient === undefined) {
    return basePrompt;
  }

  // Race assembleContext against 450ms timeout
  let memoryBlock = '';
  try {
    memoryBlock = await Promise.race([
      assembleContext(job, memoryClient, {
        candidateLimit: MEMORY_MAX_CONTEXT_MEMORIES * 2,
        tokenBudget: MEMORY_CONTEXT_TOKEN_BUDGET,
      }),
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error('assembleContext timeout')),
          450,
        ),
      ),
    ]);
  } catch (err) {
    // Timeout or error during assembly
    const isTimeout = err instanceof Error && err.message === 'assembleContext timeout';
    if (isTimeout) {
      console.warn('WARN: assembleContext timed out after 450ms — running without memory context');
    } else {
      // Circuit breaker open returns empty array -> empty string (no error thrown)
      // But if an unexpected error occurs, log it
      console.warn('WARN: memory circuit open — skipping injection');
    }
    memoryBlock = '';
  }

  // When auto-inject is disabled, log but do not append
  if (!MEMORY_AUTO_INJECT) {
    console.debug('assembleContext result (not injected):', memoryBlock);
    return basePrompt;
  }

  // Append non-empty memory block to system prompt
  if (memoryBlock === '') {
    return basePrompt;
  }

  return `${basePrompt}\n\n${memoryBlock}`;
}

export async function runAgent(
  config: AgentConfig,
  input: string | ChatMessage[],
  options?: {
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
    job?: Job;
    memoryClient?: IMemoryClient;
  },
) {
  const startedAt = Date.now();
  
  // Build system prompt with memory context if applicable
  const systemPrompt = await buildPromptWithMemory(
    config.systemPrompt,
    options?.job,
    options?.memoryClient,
  );
  
  const client = new OpenRouter({ apiKey: config.apiKey });

  const result = client.callModel({
    model: config.model,
    instructions: systemPrompt.replace('{cwd}', process.cwd()),
    input: input as string | Item[],
    tools,
    stopWhen: [stepCountIs(config.maxSteps), maxCost(config.maxCost)],
  });

  // Wire AbortSignal → result.cancel() so the underlying network stream
  // actually closes (not just the iterator we're about to walk). Also
  // handle the pre-aborted case: addEventListener('abort') does not fire
  // for signals already in the aborted state.
  const onAbort = () => result.cancel();
  options?.signal?.addEventListener('abort', onAbort);
  if (options?.signal?.aborted) result.cancel();

  // Draining getTextStream concurrently with getItemsStream reads the
  // stream dry, so getResponse().outputText ends up empty. Accumulate
  // text deltas here as source of truth for the final text.
  let accumulatedText = '';

  try {
    if (options?.onEvent) {
      const callNames = new Map<string, string>();

      const streamText = async () => {
        for await (const delta of result.getTextStream()) {
          if (options?.signal?.aborted) break;
          options.onEvent!({ type: 'text', delta });
          accumulatedText += delta;
        }
      };

      const streamTools = async () => {
        for await (const item of result.getItemsStream()) {
          if (options?.signal?.aborted) break;
          if (item.type === 'function_call') {
            callNames.set(item.callId, item.name);
            if (item.status === 'completed') {
              const args = (() => {
                try { return item.arguments ? JSON.parse(item.arguments) : {}; }
                catch { return {}; }
              })();
              options.onEvent!({ type: 'tool_call', name: item.name, callId: item.callId, args });
            }
          } else if (item.type === 'function_call_output') {
            const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
            options.onEvent!({
              type: 'tool_result',
              name: callNames.get(item.callId) ?? 'unknown',
              callId: item.callId,
              output: out.length > 200 ? out.slice(0, 200) + '...' : out,
            });
            // Signal a turn boundary so CLI can insert a separator.
            options.onEvent!({ type: 'turn_end' });
          } else if (item.type === 'reasoning') {
            const text = item.summary?.map((s: { text: string }) => s.text).join('') ?? '';
            if (text) options.onEvent!({ type: 'reasoning', delta: text });
          }
        }
      };

      await Promise.all([streamText(), streamTools()]);
    }

    const response = await result.getResponse();
    const durationMs = Date.now() - startedAt;
    const text = accumulatedText || (response.outputText ?? '');
    options?.onEvent?.({ type: 'done', usage: response.usage, durationMs });
    return { text, usage: response.usage, output: response.output, durationMs };
  } finally {
    options?.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Retry on 429/5xx — but ONLY if no tool calls have been executed yet.
 * Once a mutating tool (file_write, shell, etc.) has run, replaying the
 * whole agent from the initial prompt would double-execute side effects.
 */
export async function runAgentWithRetry(
  config: AgentConfig,
  input: string | ChatMessage[],
  options?: {
    onEvent?: (event: AgentEvent) => void;
    signal?: AbortSignal;
    maxRetries?: number;
    job?: Job;
    memoryClient?: IMemoryClient;
  },
) {
  for (let attempt = 0, max = options?.maxRetries ?? 3; attempt <= max; attempt++) {
    let toolCallsMade = 0;
    const wrappedOptions = {
      ...options,
      onEvent: (event: AgentEvent) => {
        if (event.type === 'tool_call') toolCallsMade++;
        options?.onEvent?.(event);
      },
    };
    try {
      return await runAgent(config, input, wrappedOptions);
    } catch (err: any) {
      const s = err?.status ?? err?.statusCode;
      const retryable = s === 429 || (s >= 500 && s < 600);
      if (!retryable || attempt === max || toolCallsMade > 0) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 30000);
      process.stderr.write(`[agenthq] Retrying after ${delay}ms (attempt ${attempt + 1}/${max}, status ${s})\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error('Unreachable');
}
