// ---------------------------------------------------------------------------
// Memory extraction pipeline — transforms completed job output files into
// structured, quality-gated, deduplicated memory facts stored via IMemoryClient.
//
// Entry point: extractAndStore(job, db, client)
// In-flight guard: module-level _inFlight Set prevents concurrent duplicate
// extractions for the same job ID.
//
// Sub-tasks 3.2–3.12 implement the body of _doExtract. This file provides the
// skeleton: types, constants, guard, and stubs.
// ---------------------------------------------------------------------------

import type { Job } from '../types.ts';
import type { DbAdapter } from '../db/adapter.ts';
import type { IMemoryClient, Memory } from './types.ts';
import { scopeFromJob } from './scopes.ts';
import { classifyTier } from './embedding.ts';
import { OpenRouter } from '@openrouter/sdk';
import { loadConfig } from '../config.ts';

// ---------------------------------------------------------------------------
// Internal type vocabulary
// ---------------------------------------------------------------------------

type FactCategory = 'architecture' | 'error' | 'resolution' | 'procedure' | 'constraint';

type CandidateFact = {
  text: string;
  category: FactCategory;
};

type ScoredFact = CandidateFact & {
  /** Weighted quality score ∈ [0, 1]: accuracy×0.4 + relevance×0.3 + specificity×0.3. */
  score: number;
  /** Scorer's explanation — appended to the extractor prompt in the refinement pass. */
  critique: string;
};

type ExtractionResult = {
  acceptedFacts: Array<{ text: string; category: FactCategory; retainedId: string }>;
  meanQualityScore: number;
  tier: 'hot' | 'cold';
};

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

export const GENERIC_REJECT_PATTERNS: RegExp[] = [
  /the system has \w+/i,
  /build (is )?currently failing/i,
];

const MIN_FACT_LENGTH = 20;
const MAX_FACT_LENGTH = 500;
const QUALITY_THRESHOLD = 0.75;
const DEDUP_SIMILARITY_THRESHOLD = 0.92;

// ---------------------------------------------------------------------------
// In-flight guard — process-global; shared across all extractAndStore calls
// ---------------------------------------------------------------------------

const _inFlight = new Set<string>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract memory facts from a completed job's output file and store them via
 * `client.retain`. Writes a `memory_extraction` DB row on both success and
 * failure.
 *
 * If an extraction for `job.id` is already in progress (concurrent call),
 * returns immediately without doing any work.
 *
 * @param job    The completed job whose `.mdFile` will be read.
 * @param db     Database adapter for writing the `memory_extraction` row.
 * @param client IMemoryClient used for deduplication recall and fact retention.
 */
export async function extractAndStore(
  job: Job,
  db: DbAdapter,
  client: IMemoryClient,
): Promise<void> {
  // In-flight guard — prevents duplicate concurrent extractions for the same job
  if (_inFlight.has(job.id)) return;
  _inFlight.add(job.id);

  try {
    await _doExtract(job, db, client);
  } finally {
    _inFlight.delete(job.id);
  }
}

// ---------------------------------------------------------------------------
// Internal — extraction body (stub; implemented in sub-tasks 3.2–3.12)
// ---------------------------------------------------------------------------

async function _doExtract(
  job: Job,
  db: DbAdapter,
  client: IMemoryClient,
): Promise<void> {
  // Step 1: Read the job's output file.
  // If the file is absent or empty, write a failed row and return without
  // proceeding to any LLM calls.
  let rawText = '';
  try {
    const file = Bun.file(job.mdFile);
    const exists = await file.exists();
    if (!exists) {
      console.warn(`[extraction] output file absent for job ${job.id}: ${job.mdFile}`);
      await _writeFailedRow(db, job, '');
      return;
    }
    rawText = await file.text();
  } catch (err) {
    console.warn(`[extraction] failed to read output file for job ${job.id}:`, err);
    await _writeFailedRow(db, job, '');
    return;
  }

  if (rawText.trim().length === 0) {
    console.warn(`[extraction] output file is empty for job ${job.id}: ${job.mdFile}`);
    await _writeFailedRow(db, job, '');
    return;
  }

  // Step 3: Extract candidate facts via LLM extractor call.
  let candidates: CandidateFact[];
  try {
    candidates = await _callExtractor(rawText);
  } catch (err) {
    console.error(`[extraction] LLM extractor failed for job ${job.id}:`, err);
    await _writeFailedRow(db, job, rawText);
    return;
  }

  // Step 4: Score candidate facts via the LLM quality gate scorer.
  let scoredFacts: ScoredFact[];
  try {
    scoredFacts = await _callScorer(candidates);
  } catch (err) {
    console.error(`[extraction] LLM scorer failed for job ${job.id}:`, err);
    await _writeFailedRow(db, job, rawText);
    return;
  }

  // Step 5: Refinement pass — if mean score < QUALITY_THRESHOLD, re-extract
  // with scorer critiques appended, then re-score. One pass only; the result
  // is used regardless of whether post-refinement scores improved.
  const meanScoreBeforeRefinement = _meanScore(scoredFacts);
  if (meanScoreBeforeRefinement < QUALITY_THRESHOLD) {
    const critiques = scoredFacts.map(f => f.critique);
    let refinedCandidates: CandidateFact[];
    try {
      refinedCandidates = await _callExtractor(rawText, critiques);
    } catch (refineErr) {
      console.warn(
        `[extraction] refinement extractor call failed for job ${job.id} — using original facts:`,
        refineErr,
      );
      // Fall through with original scoredFacts unchanged
      refinedCandidates = [];
    }

    if (refinedCandidates.length > 0) {
      let refinedScored: ScoredFact[];
      try {
        refinedScored = await _callScorer(refinedCandidates);
        // Replace scoredFacts with the refined results
        scoredFacts = refinedScored;
      } catch (scorerErr) {
        console.warn(
          `[extraction] refinement scorer call failed for job ${job.id} — using original facts:`,
          scorerErr,
        );
        // Fall through with original scoredFacts unchanged
      }
    }
  }

  // Step 6: Generic pattern rejection — applied before any network calls.
  // Rejects facts that match blocked patterns, are too short, or are too long.
  const patternFiltered: ScoredFact[] = [];
  for (const fact of scoredFacts) {
    const len = fact.text.length;
    if (len < MIN_FACT_LENGTH) {
      console.debug(
        `[extraction] job ${job.id}: rejected fact (too short: ${len} < ${MIN_FACT_LENGTH}): "${fact.text.slice(0, 50)}"`,
      );
      continue;
    }
    if (len > MAX_FACT_LENGTH) {
      console.debug(
        `[extraction] job ${job.id}: rejected fact (too long: ${len} > ${MAX_FACT_LENGTH}): "${fact.text.slice(0, 50)}..."`,
      );
      continue;
    }
    let patternMatched = false;
    for (const pattern of GENERIC_REJECT_PATTERNS) {
      if (pattern.test(fact.text)) {
        console.debug(
          `[extraction] job ${job.id}: rejected fact (pattern match: ${pattern}): "${fact.text.slice(0, 80)}"`,
        );
        patternMatched = true;
        break;
      }
    }
    if (!patternMatched) {
      patternFiltered.push(fact);
    }
  }

  // Step 6: Classify embedding tier — determined before dedup/retain so the tier is
  // available for the success upsert row. Hot-tier jobs receive immediate Voyage embedding;
  // cold-tier rows are queued for the 6-hour batch worker.
  const tier = await classifyTier(db, job.workspaceId);

  // Step 7: Deduplication — skipped entirely when no facts remain after pattern filtering.
  // For each remaining fact, call client.recall to check for near-duplicate memories.
  const dedupedFacts: ScoredFact[] = [];

  if (patternFiltered.length > 0) {
    const scope = scopeFromJob(job);

    for (const fact of patternFiltered) {
      let recallResult: Memory[];
      try {
        recallResult = await client.recall(fact.text, scope, 1);
      } catch (recallErr) {
        // recall threw — reject this fact and continue with the rest
        console.warn(
          `[extraction] job ${job.id}: dedup recall failed for fact "${fact.text.slice(0, 80)}" — rejecting fact:`,
          recallErr,
        );
        continue;
      }

      if (recallResult.length === 0) {
        // No existing memory found — proceed to storage
        dedupedFacts.push(fact);
        continue;
      }

      const topResult = recallResult[0]!;

      // Check whether the result carries a similarityScore field.
      // The Memory type does not declare this field (Hindsight may or may not return it).
      const rawResult = topResult as Record<string, unknown>;
      const similarityScore = rawResult['similarityScore'];

      if (typeof similarityScore === 'undefined') {
        // similarityScore absent — skip the check and proceed to storage
        console.debug(
          `[extraction] job ${job.id}: similarityScore absent on recall result — skipping dedup check for fact "${fact.text.slice(0, 80)}"`,
        );
        dedupedFacts.push(fact);
        continue;
      }

      if (typeof similarityScore === 'number' && similarityScore > DEDUP_SIMILARITY_THRESHOLD) {
        // High-similarity duplicate found — discard this fact
        console.debug(
          `[extraction] job ${job.id}: discarding duplicate fact (similarityScore=${similarityScore.toFixed(3)} > ${DEDUP_SIMILARITY_THRESHOLD}): "${fact.text.slice(0, 80)}"`,
        );
        continue;
      }

      // similarityScore present but at or below threshold — proceed to storage
      dedupedFacts.push(fact);
    }
  }

  // Step 9: Retain accepted facts — collect returned IDs for rollback in step 10.
  // Per design spec: individual retain failures are logged at WARN and skipped;
  // a single failure does not abort the whole extraction unless ALL facts fail.
  const scope = scopeFromJob(job);
  const retainedIds: string[] = [];

  for (const fact of dedupedFacts) {
    let retainedId: string;
    try {
      retainedId = await client.retain(fact.text, scope);
    } catch (retainErr) {
      console.warn(
        `[extraction] job ${job.id}: client.retain failed for fact "${fact.text.slice(0, 80)}" — skipping:`,
        retainErr,
      );
      continue;
    }
    retainedIds.push(retainedId);
  }

  // Step 10: Upsert the success row using the tier classified in step 6.
  // embedding_status = 'embedded' for hot tier, 'pending' for cold tier.
  const embeddingStatus: 'embedded' | 'pending' = tier === 'hot' ? 'embedded' : 'pending';
  const meanScore = _meanScore(dedupedFacts);
  const extractedAt = new Date().toISOString();
  const lastModified = Date.now();

  try {
    await db.execute(
      `INSERT INTO memory_extraction
         (job_id, workspace_id, extracted_at, raw_text, memory_count,
          quality_score, embedding_status, tier, last_modified)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         extracted_at     = excluded.extracted_at,
         raw_text         = excluded.raw_text,
         memory_count     = excluded.memory_count,
         quality_score    = excluded.quality_score,
         embedding_status = excluded.embedding_status,
         tier             = excluded.tier,
         last_modified    = excluded.last_modified`,
      [
        job.id,
        job.workspaceId,
        extractedAt,
        rawText,
        retainedIds.length,
        meanScore,
        embeddingStatus,
        tier,
        lastModified,
      ],
    );
  } catch (upsertErr) {
    // DB upsert failed — roll back all retained facts to keep Hindsight consistent
    // with the local DB, then write a failed row to record the failure.
    console.error(
      `[extraction] DB upsert failed for job ${job.id} — rolling back ${retainedIds.length} retained fact(s):`,
      upsertErr,
    );

    for (const retainedId of retainedIds) {
      try {
        await client.delete(retainedId);
      } catch (deleteErr) {
        console.warn(
          `[extraction] job ${job.id}: failed to roll back retained fact id="${retainedId}":`,
          deleteErr,
        );
      }
    }

    await _writeFailedRow(db, job, rawText);
  }
}

// ---------------------------------------------------------------------------
// Internal — scoring helpers
// ---------------------------------------------------------------------------

/**
 * Compute the arithmetic mean of `score` values across a `ScoredFact[]`.
 * Returns `0` for an empty array so callers can use it directly in comparisons.
 *
 * @param facts Array of scored facts (may be empty).
 * @returns Mean score ∈ [0, 1], or 0 when the array is empty.
 */
function _meanScore(facts: ScoredFact[]): number {
  if (facts.length === 0) return 0;
  const total = facts.reduce((sum, f) => sum + f.score, 0);
  return total / facts.length;
}

// ---------------------------------------------------------------------------
// Internal — LLM extractor call
// ---------------------------------------------------------------------------

/** System prompt for the memory fact extractor. */
const EXTRACTOR_SYSTEM_PROMPT = `You are a memory extraction assistant. Your job is to read agent job output and extract structured, factual memories that would be useful to recall in future sessions.

Extract facts about: architecture decisions, errors encountered, resolutions applied, procedures used, and constraints discovered.

Return ONLY a JSON object with a single key "facts" whose value is an array of objects. Each object must have:
- "text": a clear, self-contained statement (20–500 characters)
- "category": one of "architecture", "error", "resolution", "procedure", "constraint"

Example:
{"facts": [{"text": "SQLite WAL mode is enabled by the adapter on first connection.", "category": "architecture"}]}`;

/**
 * Call the LLM extractor to derive candidate facts from a job's raw text.
 *
 * On JSON parse failure or wrong response shape, throws an Error — the caller
 * catches and writes a failed row.
 *
 * @param text      Raw text content of the job's output file.
 * @param critiques Optional list of scorer critiques from the previous pass,
 *                  appended to the prompt for the refinement pass.
 * @returns Array of validated candidate facts.
 * @throws {Error} When the LLM returns unparseable JSON or a non-conforming shape.
 */
async function _callExtractor(
  text: string,
  critiques?: string[],
): Promise<CandidateFact[]> {
  const config = loadConfig({}, { skipApiKey: true });
  const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || '';

  if (!apiKey) {
    throw new Error('[extraction] OPENROUTER_API_KEY is not set — cannot call extractor');
  }

  // Build the user message, appending critiques for refinement passes
  let userContent = `Extract memory facts from the following agent job output:\n\n${text}`;
  if (critiques !== undefined && critiques.length > 0) {
    const critiqueBlock = critiques
      .map((c, i) => `  ${i + 1}. ${c}`)
      .join('\n');
    userContent += `\n\nPrevious extraction had low-quality facts. Critiques from the scorer:\n${critiqueBlock}\n\nPlease produce more specific, accurate, and relevant facts based on this feedback.`;
  }

  const client = new OpenRouter({ apiKey, retryConfig: { strategy: 'none' } });

  const result = await client.chat.send({
    chatRequest: {
      model: config.model,
      messages: [
        { role: 'system', content: EXTRACTOR_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      responseFormat: { type: 'json_object' },
      temperature: 0.1,
      maxTokens: 2048,
    },
  });

  // Extract text content from the response
  const rawContent = result.choices[0]?.message?.content;
  const responseText = typeof rawContent === 'string' ? rawContent : '';

  if (!responseText) {
    throw new Error('[extraction] extractor returned empty response');
  }

  // Parse JSON — throw on failure so the caller can write a failed row
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (cause) {
    throw new Error(
      `[extraction] extractor returned invalid JSON: ${String(cause)}`,
    );
  }

  // Validate shape: must be { facts: Array<{ text: string, category: FactCategory }> }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>)['facts'])
  ) {
    throw new Error(
      '[extraction] extractor response missing "facts" array — got: ' +
      JSON.stringify(parsed).slice(0, 200),
    );
  }

  const factsRaw = (parsed as Record<string, unknown[]>)['facts'];
  const VALID_CATEGORIES = new Set<string>([
    'architecture', 'error', 'resolution', 'procedure', 'constraint',
  ]);

  const facts: CandidateFact[] = [];
  for (let i = 0; i < factsRaw.length; i++) {
    const item = factsRaw[i];
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as Record<string, unknown>)['text'] !== 'string' ||
      typeof (item as Record<string, unknown>)['category'] !== 'string'
    ) {
      throw new Error(
        `[extraction] extractor fact[${i}] missing required 'text' or 'category' string fields`,
      );
    }
    const category = (item as Record<string, unknown>)['category'] as string;
    if (!VALID_CATEGORIES.has(category)) {
      throw new Error(
        `[extraction] extractor fact[${i}] has invalid category '${category}' — ` +
        'must be one of: architecture, error, resolution, procedure, constraint',
      );
    }
    facts.push({
      text: (item as Record<string, unknown>)['text'] as string,
      category: category as FactCategory,
    });
  }

  return facts;
}

// ---------------------------------------------------------------------------
// Internal — LLM scorer call
// ---------------------------------------------------------------------------

/** System prompt for the quality gate scorer. */
const SCORER_SYSTEM_PROMPT = `You are a memory quality scorer. Your job is to evaluate each candidate memory fact on three dimensions and return a numeric score with an explanation.

Scoring rubric (weights must sum to 1.0):
- accuracy   (weight 0.4): Is the fact factually correct and precise?
- relevance  (weight 0.3): Is the fact useful to recall in a future agent session?
- specificity (weight 0.3): Is the fact specific enough to be actionable (not generic)?

For EACH fact, compute: score = (accuracy × 0.4) + (relevance × 0.3) + (specificity × 0.3)
The final score must be a number in [0, 1].

Return ONLY a JSON object with a single key "scores" whose value is an array of objects — one object per input fact, in the same order as the input. Each object must have:
- "score": a number in [0, 1] (three decimal places is fine)
- "critique": a short sentence explaining the score (used to guide a refinement pass)

Example for 2 input facts:
{"scores": [{"score": 0.85, "critique": "Specific and actionable architecture fact."}, {"score": 0.40, "critique": "Too generic — does not identify which component or version."}]}`;

/**
 * Call the LLM quality gate scorer to score each candidate fact.
 *
 * Returns a `ScoredFact[]` in the same order as the input `facts` array.
 * Throws when:
 * - The LLM call itself throws
 * - The returned JSON is invalid or missing the "scores" array
 * - The returned array length does not match `facts.length`
 * - Any item is missing a numeric `score` ∈ [0, 1] or a string `critique`
 *
 * @param facts Candidate facts from the extractor pass to score.
 * @returns Parallel `ScoredFact[]` with score and critique merged in.
 * @throws {Error} On any validation failure — the caller writes a failed row.
 */
async function _callScorer(facts: CandidateFact[]): Promise<ScoredFact[]> {
  const config = loadConfig({}, { skipApiKey: true });
  const apiKey = config.apiKey || process.env.OPENROUTER_API_KEY || '';

  if (!apiKey) {
    throw new Error('[extraction] OPENROUTER_API_KEY is not set — cannot call scorer');
  }

  // Serialize the facts array so the LLM knows exactly what to score
  const factsJson = JSON.stringify(
    facts.map((f, i) => ({ index: i, text: f.text, category: f.category })),
    null,
    2,
  );

  const userContent =
    `Score each of the following ${facts.length} memory facts using the rubric described in the system prompt.\n\n` +
    `Return exactly ${facts.length} score objects in the same order.\n\n` +
    `Facts:\n${factsJson}`;

  const client = new OpenRouter({ apiKey, retryConfig: { strategy: 'none' } });

  const result = await client.chat.send({
    chatRequest: {
      model: config.model,
      messages: [
        { role: 'system', content: SCORER_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      responseFormat: { type: 'json_object' },
      temperature: 0.1,
      maxTokens: 2048,
    },
  });

  // Extract text content from the response
  const rawContent = result.choices[0]?.message?.content;
  const responseText = typeof rawContent === 'string' ? rawContent : '';

  if (!responseText) {
    throw new Error('[extraction] scorer returned empty response');
  }

  // Parse JSON — throw on failure so the caller can write a failed row
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch (cause) {
    throw new Error(
      `[extraction] scorer returned invalid JSON: ${String(cause)}`,
    );
  }

  // Validate outer shape: must be { scores: Array<...> }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as Record<string, unknown>)['scores'])
  ) {
    throw new Error(
      '[extraction] scorer response missing "scores" array — got: ' +
      JSON.stringify(parsed).slice(0, 200),
    );
  }

  const scoresRaw = (parsed as Record<string, unknown[]>)['scores'];

  // Validate array length matches input — mismatch is a scorer error
  if (scoresRaw.length !== facts.length) {
    throw new Error(
      `[extraction] scorer array length mismatch: expected ${facts.length} got ${scoresRaw.length}`,
    );
  }

  // Validate each item and merge into ScoredFact[]
  const scoredFacts: ScoredFact[] = [];
  for (let i = 0; i < scoresRaw.length; i++) {
    const item = scoresRaw[i];

    if (typeof item !== 'object' || item === null) {
      throw new Error(
        `[extraction] scorer scores[${i}] is not an object — got: ${JSON.stringify(item)}`,
      );
    }

    const raw = item as Record<string, unknown>;
    const score = raw['score'];
    const critique = raw['critique'];

    if (typeof score !== 'number') {
      throw new Error(
        `[extraction] scorer scores[${i}].score is not a number — got: ${JSON.stringify(score)}`,
      );
    }

    if (score < 0 || score > 1) {
      throw new Error(
        `[extraction] scorer scores[${i}].score is out of range [0, 1] — got: ${score}`,
      );
    }

    if (typeof critique !== 'string') {
      throw new Error(
        `[extraction] scorer scores[${i}].critique is not a string — got: ${JSON.stringify(critique)}`,
      );
    }

    scoredFacts.push({
      text: facts[i]!.text,
      category: facts[i]!.category,
      score,
      critique,
    });
  }

  return scoredFacts;
}

// ---------------------------------------------------------------------------
// Internal — failure row writer
// ---------------------------------------------------------------------------

/**
 * Upsert a failed `memory_extraction` row for the given job.
 * Uses `ON CONFLICT(job_id) DO UPDATE` so repeated failures overwrite the
 * previous record rather than accumulating extra rows.
 *
 * @param db      Database adapter.
 * @param job     The job that failed extraction.
 * @param rawText Raw text read from the job file, or empty string if unreadable.
 */
async function _writeFailedRow(
  db: DbAdapter,
  job: Job,
  rawText: string,
): Promise<void> {
  const now = Date.now();
  await db.execute(
    `INSERT INTO memory_extraction
       (job_id, workspace_id, extracted_at, raw_text, memory_count,
        quality_score, embedding_status, tier, last_modified)
     VALUES (?, ?, ?, ?, 0, 0.0, 'failed', 'cold', ?)
     ON CONFLICT(job_id) DO UPDATE SET
       extracted_at     = excluded.extracted_at,
       raw_text         = excluded.raw_text,
       memory_count     = 0,
       quality_score    = 0.0,
       embedding_status = 'failed',
       last_modified    = excluded.last_modified`,
    [job.id, job.workspaceId, new Date().toISOString(), rawText, now],
  );
}


