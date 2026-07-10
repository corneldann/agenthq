# Kiro Spec Format Rules

When creating or editing any spec document under `.kiro/specs/`, strictly follow
these format rules. Violations cause diagnostic errors shown to the user.

---

## requirements.md Rules

### H1 Heading (REQUIRED — ERROR if missing)

The FIRST line MUST be exactly:

```
# Requirements Document
```

Do NOT include phase name, colon, or subtitle in the H1.
Put the descriptive name in the `## Introduction` section instead.

```
BAD:  # Requirements Document: Phase 5.1 — Database Layer
GOOD: # Requirements Document
```

### Required Sections (in order)

1. `# Requirements Document`
2. `## Introduction`
3. `## Glossary`
4. `## Requirements`
   - Each requirement: `### Requirement N: <Title>`
   - Each with: `**User Story:**` and `#### Acceptance Criteria`

---

## design.md Rules

### H1 Heading (REQUIRED — ERROR if missing)

The FIRST line MUST be exactly:

```
# Design Document
```

Do NOT include phase name or subtitle in the H1.
Put the descriptive name in the `## Overview` section instead.

```
BAD:  # Design Document: Phase 5.1 — Database Layer
GOOD: # Design Document
```

### Required Sections (ERROR if missing)

- `## Overview`
- `## Architecture`
- `## Data Models`

### Recommended Sections (WARNING if missing)

- `## Correctness Properties`
- `## Error Handling`

### Correctness Properties Template

```markdown
## Correctness Properties

### Invariants
1. **<Name>** — <condition that must always hold>

### Round-Trip Properties
1. **<Name>** — <serialize/deserialize identity>

### Bounded Operations
1. **<Name>** — <time/size bound that must not be exceeded>
```

### Error Handling Template

```markdown
## Error Handling

### Failure Modes and Recovery

**<Failure Name>**
- **Detection:** <how the system detects this failure>
- **Response:** <what the system does immediately>
- **Recovery:** <how operation is restored>
```

---

## tasks.md Rules

### H1 Heading (REQUIRED)

The FIRST line MUST start with:

```
# Implementation Plan:
```

Include the spec name after the colon, e.g. `# Implementation Plan: Phase 5.1 — Database Layer`.

```
BAD:  # Tasks
GOOD: # Implementation Plan: Phase 5.1 — Database Layer
```

### Required Structure

- At least one `## Task N: <Title>` section
- Each task SHOULD have sub-tasks as a checklist

---

## Quick Checklist Before Creating Any Spec Doc

- [ ] `requirements.md` H1 is exactly `# Requirements Document`
- [ ] `design.md` H1 is exactly `# Design Document`
- [ ] `tasks.md` H1 is exactly `# Tasks`
- [ ] `design.md` has `## Overview`, `## Architecture`, `## Data Models`
- [ ] `design.md` has `## Correctness Properties`
- [ ] `design.md` has `## Error Handling`
- [ ] No phase name or subtitle appended to any H1 heading
