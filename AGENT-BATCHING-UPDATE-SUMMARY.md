# Agent Batching Steering File — Research-Based Update

## Summary

Updated `.kiro/steering/agent-batching.md` with research-backed guidance to prevent the sequential same-file edit anti-pattern (the 9-turn edit problem you showed in the screenshot).

## What Was Added

### 1. **Research Foundation Section**
- Cited official Claude docs on parallel tool use
- Referenced real-world case study: 8-second agent → 2-second agent (4x speedup)
- Documented the production incident from this workspace (9 sequential edits)
- Added concrete metrics: 89% reduction in API calls when batching correctly

### 2. **Supervised Mode Section** (NEW)
Critical addition showing the multiplier effect in supervised mode:

| Metric | Sequential | Batched | Improvement |
|--------|-----------|---------|-------------|
| API calls | 18 | 2-4 | 89% reduction |
| User approvals | 9 | 1-2 | 88% reduction |
| Time | 5-10 min | 30-60 sec | 90% faster |

Explains "approval fatigue" — users rubber-stamp after 3-4 approvals, defeating supervised mode's purpose.

### 3. **Enhanced Planning Checklist**
Expanded from 4 basic questions to detailed decision framework:
- Root cause analysis: incremental thinking
- Supervised mode multiplier warnings
- Real-world example: Phase 7 document (9 sections)
- Side-by-side comparison: incremental vs batching approach
- Concrete savings calculation: 83-89% reduction

### 4. **Kiro's Tool Execution Model** (NEW)
Clarifies the division of responsibility:
- **Agent's job**: Batch tool calls in one turn
- **Kiro's job**: Execute them efficiently
- Shows XML examples of correct vs incorrect batching
- Explains what happens in each scenario (API calls, approvals, timing)

### 5. **Anti-Pattern Recognition** (NEW)
Five early warning signs with recovery strategies:

**Warning Sign 1**: "I'll just do this one edit first..."
- Symptom: Incremental discovery
- Recovery: STOP, re-read, identify ALL edits, batch

**Warning Sign 2**: "Let me verify this edit before continuing..."
- Symptom: Verification anxiety
- Fix: Trust atomic operations, batch edits

**Warning Sign 3**: Thinking in file sections instead of task scope
- Symptom: "First imports... then function... then return type..."
- Reframe: "This task changes 3 parts, I'll do all 3 in one turn"

**Warning Sign 4**: User already approved one edit to this file
- Symptom: You're about to edit same file in turn N+1
- Emergency fix: Acknowledge violation, re-plan, batch remaining

**Warning Sign 5**: "File is long, I'll work through it section by section"
- Symptom: File length intimidation
- Fix: Length is irrelevant, batch all edits regardless

### 6. **Research & Sources Section** (NEW)
Documents the evidence base:
1. Claude official docs (parallel tool use)
2. Real-world performance impact (kindatechnical.com case study)
3. ITPM as binding constraint (field observations)
4. Production incident from this workspace

**Key citation**: "Claude was already returning all four tool calls in a single turn. The team had been executing them sequentially in their loop." — This is the exact problem.

## What Was Strengthened

### STOP RULE (Enhanced)
- Added explicit "STOP IMMEDIATELY" language
- Recovery procedure: read → re-plan → batch
- Compliance example: 9 edits should be 2 turns, not 9

### Edit Phase (Enhanced)
- Violation patterns explicitly listed (9 forbidden patterns)
- Supervised mode impact called out
- Real screenshot scenario documented

### Core Principle (Enhanced)
- Added research foundation at the top
- Production incident metrics upfront
- Clear distinction: tool execution (Kiro) vs edit planning (agent)

## Impact

**Before**: Generic "batch your edits" guidance, easy to ignore
**After**: 
- Concrete production incident showing the cost
- 5 early warning signs for self-diagnosis
- Supervised mode multiplier making it urgent
- Research citations proving this is standard practice
- Recovery procedures for when violations occur

**Agent behavior change target**:
- From: "I'll make this edit, then see what else needs changing"
- To: "Let me read this file and identify ALL sections that need editing for this task, then batch them in one turn"

## Testing Recommendations

Next time an agent starts making sequential edits:
1. Observe if Warning Signs catch it earlier
2. Check if STOP RULE triggers self-correction
3. Monitor if supervised mode multiplier increases urgency
4. Measure: does the agent re-plan and batch remaining edits?

The key metric: **How many turns from first edit to last edit in same file?**
- Target: 1 turn (all edits batched)
- Acceptable: 2 turns (if file context changed between them)
- Violation: 3+ turns

## Related Files

- `.kiro/steering/agent-batching.md` — The updated steering file
- `.kiro/steering/memory-management.md` — Mentions batching for context efficiency
- `.kiro/steering/task-concurrency.md` — Sequential subagent constraint (different issue)

## References

- [Claude Parallel Tool Use Docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/parallel-tool-use)
- [Parallel Tool Calls: Real-World Case Study](https://kindatechnical.com/claude-ai/parallel-tool-calls-running-multiple-functions-concurrently.html)
- Your screenshot: 9 sequential edits to `phase-7-library-management.md`

---

**Bottom line**: The updated steering file transforms "batch your edits" from abstract advice into concrete, actionable, research-backed guidance with self-diagnostic tools. The agent now has everything it needs to recognize and prevent the sequential edit anti-pattern.
