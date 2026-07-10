---
inclusion: always
---

# Agent Batching — Quick Reference Card

**ONE-SENTENCE RULE**: If you need to edit the same file multiple times, do ALL edits in ONE turn with parallel `str_replace` calls.

---

## The Golden Pattern (2 turns for any N edits)

```
Turn 1: Read file, identify ALL N sections that need changes
Turn 2: Invoke all N str_replace calls in parallel
(Turn 3: Optional verify with get_diagnostics)
```

**Not**: Read → edit 1 → edit 2 → edit 3... (N+1 turns)

---

## Before You Make ANY Edit — Ask:

1. ☑ **How many sections need to change?** (Find ALL upfront, not incrementally)
2. ☑ **Have I already edited this file in a previous turn?** (If YES → VIOLATION, re-plan)
3. ☑ **Am I thinking "just one more edit"?** (If YES → VIOLATION, batch all remaining)

---

## Red Flags (STOP IMMEDIATELY if you see these)

🚨 **"I'll do this edit first, then see what else needs fixing"**
→ Incremental discovery. Stop, re-read, find ALL edits, batch them.

🚨 **"Let me verify this edit before making the next one"**
→ Verification anxiety. Trust atomic operations, batch all edits.

🚨 **You just made turn N editing file X, now you're about to make turn N+1 editing file X**
→ Already violated. Acknowledge it, re-plan remaining edits, batch them.

---

## Supervised Mode Multiplier

Sequential edits in supervised mode:
- ❌ N edits = N user approvals = 2N API calls = approval fatigue
- ✅ N edits in 1 turn = 1 approval = 2 API calls = happy user

---

## Cost Table (Example: 9 edits)

| Approach | Turns | API Calls | User Approvals | Time |
|----------|-------|-----------|----------------|------|
| Sequential | 9 | 18 | 9 | 5-10 min |
| Batched | 2 | 2 | 1 | 30 sec |
| **Waste** | **7** | **16** | **8** | **89%** |

---

## XML Pattern (Correct Batching)

```xml
<function_calls>
  <invoke name="str_replace">
    <parameter name="path">file.ts</parameter>
    <parameter name="oldStr">section 1 old</parameter>
    <parameter name="newStr">section 1 new</parameter>
  </invoke>
  <invoke name="str_replace">
    <parameter name="path">file.ts</parameter>
    <parameter name="oldStr">section 2 old</parameter>
    <parameter name="newStr">section 2 new</parameter>
  </invoke>
  <invoke name="str_replace">
    <parameter name="path">file.ts</parameter>
    <parameter name="oldStr">section 3 old</parameter>
    <parameter name="newStr">section 3 new</parameter>
  </invoke>
</function_calls>
```

All three execute in ONE turn. User approves ONCE. Done.

---

## When You Catch Yourself Mid-Violation

**You just made edit 1, about to make edit 2 to same file:**

1. ⏸ **STOP** — Do not make edit 2 yet
2. 🔍 **Re-read** the file (if needed)
3. 📋 **Identify** ALL remaining edits for this task
4. 📦 **Batch** all remaining edits in ONE turn
5. 💬 **Tell user**: "I should have batched these edits. Doing the remaining N edits in one turn now."

---

## Why This Matters

**Research-proven**:
- Real case: 8-second agent → 2-second agent (4x speedup) just by batching
- ITPM (input tokens per minute) is the rate limit, not RPM
- Every turn re-sends full context (system prompt + tools + history)
- Production incident: 9 sequential edits = 89% wasted API calls

**Source**: [Claude docs](https://docs.claude.com/en/docs/agents-and-tools/tool-use/parallel-tool-use) + [field research](https://kindatechnical.com/claude-ai/parallel-tool-calls-running-multiple-functions-concurrently.html)

---

## Sub-Agent Identity Check

**If your prompt starts with:**
```
CONTEXT: You are operating as a sub-agent invoked via invoke_sub_agent.
```

Then:
- ✅ Write ALL files directly, regardless of size (use fs_write + fs_append)
- ✅ You MAY spawn a further sub-agent for sequential verification after completing your work
- 🚫 Do NOT spawn sub-agents concurrently (causes throttle cascade in this workspace)
- 🚫 Do NOT spawn a sub-agent just to write a large file — write it directly

**Platform depth limit**: 5 levels max (Claude Code v2.1.172+). This workspace's
ITPM constraint means sequential nesting is fine, concurrent nesting is not.

---

## Final Reminder

**Batching is not an optimization. It's the default correct behavior.**

Sequential edits are the anti-pattern.

Plan upfront → Batch in one turn → User approves once → Done.
