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

1. Read the PRD at `prd.json`
2. Read the progress log at `progress.txt` (check Codebase Patterns section first)
3. Check you're on the correct branch from PRD `branchName`. If not, check it out or create from main.
4. Pick the **highest priority** user story where `passes: false`
5. Implement that single user story
6. Run quality checks (see below)
7. Update AGENTS.md files if you discover reusable patterns (see below)
8. If checks pass, commit ALL changes with message: `feat: [Story ID] - [Story Title]`
9. Update the PRD to set `passes: true` for the completed story
10. Append your progress to `progress.txt`

## 3. Quality Checks

Read the `commands` section in `.ralphi/config.yaml` and run each configured command (test, lint, build, typecheck, etc.). You can also run `ralphi ralph check` which runs all commands in sequence.

Quality checks are also enforced by a pre-commit hook. If you try to commit and checks fail, fix the issues and try again. Do NOT use `git commit --no-verify`.

## 4. Progress Report Format

APPEND to progress.txt (never replace, always append):
```
## [Date/Time] - [Story ID]
Session: [Session URL/ID if available, else N/A]
- What was implemented
- Files changed
- **Learnings for future iterations:**
  - Patterns discovered (e.g., "this codebase uses X for Y")
  - Gotchas encountered (e.g., "don't forget to update Z when changing W")
  - Useful context (e.g., "the evaluation panel is in component X")
---
```

Include a session reference if your engine provides one. Otherwise write `N/A`.

## 5. Consolidate Patterns

If you discover a **reusable pattern**, add it to the `## Codebase Patterns` section at the TOP of progress.txt (create if it doesn't exist). Only add patterns that are **general and reusable**, not story-specific.

## 6. Update AGENTS.md Files

Before committing, check if edited files have learnings worth preserving in nearby AGENTS.md files:
- API patterns or conventions specific to that module
- Gotchas or non-obvious requirements
- Dependencies between files
- Testing approaches

## 7. Quality Requirements

- ALL commits must pass quality checks
- Do NOT commit broken code
- Keep changes focused and minimal
- Follow existing code patterns
- Use the `ralphi_ask_user_question` tool if you need to clarify something with the user

## Important

- Work on ONE story per iteration
- Commit frequently
- Keep CI green
- Read the Codebase Patterns section in progress.txt before starting
