---
name: ralphi-convert
description: "Converts PRD markdown files to .ralphi/prd.json format for the Ralph autonomous agent loop. Use when asked to convert a PRD, create .ralphi/prd.json, or turn a PRD into Ralph format."
---

# Ralph PRD Converter

Convert a PRD markdown file into `.ralphi/prd.json` format for the Ralph autonomous agent loop.

## Workflow

1. Read the PRD markdown file provided by the user.
2. Run a short planning pass before conversion:
   - Split oversized stories so each can be completed in one iteration
   - Order by dependencies (schema/backend before UI)
   - Add `dependsOn` links for blocked stories
3. If `.ralphi/prd.json` already exists with a **different** `branchName`, archive it first to `.ralphi/archive/YYYY-MM-DD-feature-name/` before overwriting.
4. Convert the PRD content into structured JSON following the output format below.
5. Write the result to `.ralphi/prd.json`. 

## Output Format

```json
{
  "project": "<project name>",
  "branchName": "ralph/<feature-name-kebab-case>",
  "description": "<brief project description>",
  "userStories": [
    {
      "id": "US-001",
      "title": "<story title>",
      "description": "<story description>",
      "acceptanceCriteria": ["<criterion 1>", "<criterion 2>"],
      "priority": 1,
      "status": "open",
      "dependsOn": [],
      "notes": ""
    }
  ]
}
```

## Story Sizing — The Number One Rule

Each story must be completable in **one iteration** (one context window).

**Right-sized examples:**
- Add a database column
- Add a UI component
- Update a server action

**Too big — split these:**
- Build entire dashboard
- Add authentication

## Story Ordering — Dependencies First

Order stories by dependency chain:

1. Schema / database changes
2. Server actions / backend logic
3. UI components
4. Dashboard / summary views

## Acceptance Criteria — Must Be Verifiable

- **Good:** "Add status column with default 'pending'"
- **Bad:** "Works correctly"
- Always include quality checks (lint, type-check, tests pass) as final criteria in each story.

## Conversion Rules

1. Each user story in the PRD becomes one JSON entry.
2. IDs are sequential: `US-001`, `US-002`, etc.
3. Priority is based on dependency order (1 = first).
4. All stories start with `status: "open"`, `dependsOn: []`, and empty `notes`.
5. Add `dependsOn` IDs when a story is blocked by another story (dependency chain should still match priority order).
6. `branchName` is kebab-case, prefixed with `ralph/`.

