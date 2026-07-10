# File Size Limits Update — Character-Based Guidance

## Problem Identified

From actual Kiro error message:
> "The model output was truncated before this tool call was complete. When writing files, limit each fs_write call to 50 lines or fewer..."

However, **lines vary in length**:
- 100 short lines (30 chars) = 3,000 chars ✅ safe
- 50 long lines (200 chars) = 10,000 chars ❌ overflow

Line count is a poor proxy for the real limit: **character/token count in model output**.

## Previous Limits

| Version | fs_write | fs_append | Delegation | Issue |
|---------|----------|-----------|------------|-------|
| Original | 50 lines | 50 lines | 100 lines | Too conservative |
| v2 | 200 lines | 200 lines | 200 lines | Caused overflow errors |
| v3 | 200 lines | 200 lines | 400 lines | Still causing truncation |

## New Limits (Character-Based)

**Primary guidance**: ~3,000-4,000 characters per fs_write/fs_append call

**Secondary guidance by content type** (since agents can't easily count chars):

| Content Type | Lines per Chunk | Why |
|--------------|----------------|-----|
| TypeScript/JS (typical formatting) | ~80-100 | Lots of whitespace, short lines |
| Dense prose/documentation | ~50-60 | Long paragraphs, few line breaks |
| JSON/config with nesting | ~60-80 | Medium line length |
| Markdown with code blocks | ~70-90 | Mix of prose and code |

**Delegation threshold**: Still 400-500 lines OR 16,000+ characters OR 5+ fs_write/fs_append calls

## Updated Files

1. **`.kiro/steering/agent-batching.md`**
   - Changed from "100 lines max" to "~3,000-4,000 characters max (roughly 50-100 lines depending on line length)"
   - Added "How to estimate" section with guidelines by content type
   - Updated STOP RULE from "4th fs_append" to "4th fs_append (roughly 400-500 lines or 16,000+ chars)"
   - Added explicit note: "The limit is based on character count, not line count"

2. **`.kiro/steering/BATCHING-QUICK-REFERENCE.md`**
   - No changes needed (doesn't mention specific limits)

3. **`.kiro/steering/memory-management.md`**
   - Already didn't have the old 50-line limits

## Why This Is Better

### Before (line-based):
```
Agent writes 50-line file with long lines (15,000 chars)
→ Tries fs_write with all 50 lines
→ Truncation error
→ Confusion: "But it's only 50 lines!"
```

### After (character-based with type heuristics):
```
Agent writes dense documentation file
→ Sees guidance: "dense prose = ~50-60 lines per chunk"
→ Writes in 50-line chunks
→ Success
```

```
Agent writes TypeScript with lots of whitespace
→ Sees guidance: "TypeScript = ~80-100 lines per chunk"
→ Writes in 90-line chunks
→ Success
```

## Implementation Note

The agent still thinks in **lines** (easier to count while writing), but now has **content-type-specific guidance** that approximates the character limit:

- Short lines (code) → use higher line count
- Long lines (prose) → use lower line count
- Unknown → default to ~60-70 lines (conservative)

This gives the agent actionable guidance without requiring character counting, while still respecting the underlying character-based limit.

## Testing Recommendations

Monitor for:
1. **False positives** — agent being too conservative (50 lines of code when 100 would work)
2. **False negatives** — agent hitting truncation with "safe" line counts
3. **Content type misidentification** — treating dense prose as code

Adjust the content-type heuristics table based on real-world patterns.

---

**Bottom line**: The 50-line Kiro message was platform guidance (conservative), not a hard limit. The real limit is ~3,000-4,000 chars. We now give content-type-specific line count guidance that respects this.
