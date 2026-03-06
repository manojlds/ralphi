---
name: ralphi-loop
description: Executing a single iteration of the ralph autonomous coding loop. Use when ralph invokes the agent to implement the next user story from the PRD.
---

# Ralph Agent — Per-Iteration Instructions

You are an autonomous coding agent working on a software project.

## 1. Load Configuration

Read `.ralphi/config.yaml` for project name, language, and framework.

Read the `rules` section in `.ralphi/config.yaml` and follow every rule listed.

Read the `boundaries.never_touch` section in `.ralphi/config.yaml`. Do NOT modify any file matching those patterns.

## 2. Your Task

1. Read the PRD at `.ralphi/prd.json`
2. Read the progress log at `.ralphi/progress.txt` (check Codebase Patterns section first)
3. Check you're on the correct branch from PRD `branchName`. If not, check it out or create from main.
4. Pick the **highest priority unblocked** user story:
   - Prefer `status: "open"`
   - If no open stories are available, resume `status: "in_progress"`
5. Implement that single user story
6. Run the **REQUIRED Post-Implementation Step-Back Review Protocol** (Section 3)
7. Run quality checks (see below)
8. Update AGENTS.md files if you discover reusable patterns (see below)
9. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`
10. Update the PRD for the completed story:
   - `status: "done"`
11. Append your progress to `.ralphi/progress.txt`

## 3. REQUIRED Post-Implementation Step-Back Review Protocol

Run this protocol **after implementation** and **before quality checks/commit**.

1. **Re-ground in source of truth**
   - Re-read the target story in `.ralphi/prd.json` (description + acceptance criteria)
   - Re-read `## Codebase Patterns` and the latest iteration entry in `.ralphi/progress.txt`
2. **Run a deterministic code review pass**
   - Review every changed file against this checklist:
     - Every change maps to at least one acceptance criterion
     - No unrelated refactors or scope creep were introduced
     - Tests were added/updated where behavior changed
     - `.ralphi/config.yaml` rules and boundaries are still respected
   - Set `Review Outcome` to exactly one value: `PASS` or `CHANGES_REQUIRED`
   - If `CHANGES_REQUIRED`, fix issues and run this protocol again
3. **Run a PRD trajectory check**
   - Classify trajectory with exactly one value:
     - `ON_TRACK` — Implementation is aligned with PRD intent/scope
     - `RISK` — Still aligned, but has a known dependency/open risk
     - `DRIFT` — Current implementation diverges from PRD intent/scope
   - Record a short rationale for `RISK` or `DRIFT`
   - If `DRIFT`, define a corrective plan and do not mark the story complete until corrected

## 4. Quality Checks

Read the `commands` section in `.ralphi/config.yaml` and run each configured command (test, lint, build, typecheck, etc.). You can also run `ralphi ralph check` which runs all commands in sequence.

Quality checks are also enforced by a pre-commit hook. If you try to commit and checks fail, fix the issues and try again. Do NOT use `git commit --no-verify`.

## 5. Progress Report Format

APPEND to `.ralphi/progress.txt` (never replace, always append):
```
## [Date/Time] - [Story ID]
Session: [Session URL/ID if available, else N/A]
Review Outcome: [PASS | CHANGES_REQUIRED]
Trajectory: [ON_TRACK | RISK | DRIFT]
Trajectory Notes: [Short rationale; required for RISK/DRIFT, else N/A]
Corrective Plan: [Required if DRIFT, else N/A]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the evaluation panel is in component X")
---
```

Include a session reference if your engine provides one. Otherwise write `N/A`.

## 6. Consolidate Patterns

If you discover a **reusable pattern**, add it to the `## Codebase Patterns` section at the TOP of `.ralphi/progress.txt` (create if it doesn't exist). Only add patterns that are **general and reusable**, not story-specific.

## 7. Update AGENTS.md Files

Before committing, check if edited files have learnings worth preserving in nearby AGENTS.md files:
- API patterns or conventions specific to that module
- Gotchas or non-obvious requirements
- Dependencies between files
- Testing approaches

## 8. Quality Requirements

- ALL commits must pass quality checks
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns

## Important

- Work on ONE story per iteration
- Commit frequently
- Keep CI green
- Read the Codebase Patterns section in `.ralphi/progress.txt` before starting
- This phase is prompt/skill-driven only; do not require runtime command/tool changes for this review protocol
