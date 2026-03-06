# ralphi

`ralphi` is a Pi-native implementation of the **Ralph autonomous loop pattern**.

The name is literal: **Ralph + Pi = ralphi**.

It gives you a structured, repeatable workflow for planning and implementing features with fresh-context loop iterations.

---

## What ralphi does

`ralphi` provides a phased workflow plus an autonomous implementation loop:

1. **`/ralphi-init`** — initialize project config and guardrails
2. **`/ralphi-prd`** — generate PRD markdown from a feature idea
3. **`/ralphi-convert`** — convert PRD markdown into `.ralphi/prd.json`
4. **`/ralphi-loop-start`** — run iterative implementation against `.ralphi/prd.json`

Core behavior:
- Commands are namespaced under `/ralphi-*`
- Completion is driven by the `ralphi_phase_done` tool
- Loop iterations run in fresh child sessions
- `.ralphi/prd.json` is the source of truth for pending stories (`status != done`)
- Loop supports explicit completion (`complete: true`) and auto-completes when no pending stories remain

---

## Install

### From npm (recommended)

```bash
pi install npm:@manojlds/ralphi
```

This installs the package and loads its bundled extension + skills automatically.

If you prefer editing settings manually, add this to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "npm:@manojlds/ralphi"
  ]
}
```

Then restart Pi or run `/reload`.

### Local development / path install

For developing `ralphi` itself, use a direct path in project-level `.pi/settings.json`:

```json
{
  "packages": [
    ".."
  ]
}
```

This overrides the npm package so local changes are picked up live.

---

## Quick start (typical flow)

### 1) Initialize project settings

```text
/ralphi-init
```

This phase prepares `.ralphi/config.yaml` and establishes rules/commands for the project.

### 2) Create a PRD

```text
/ralphi-prd <name> <description>
```

Example:
```text
/ralphi-prd loop-guidance add loop trajectory guard and review gates
```

If `name` or `description` is omitted in TUI mode, ralphi prompts for them.

### 3) Convert PRD markdown to `.ralphi/prd.json`

```text
/ralphi-convert tasks/prd-<feature>.md
```

### 4) Start the autonomous loop

```text
/ralphi-loop-start --max-iterations 50
```

Monitor and control with:
- `/ralphi-loop-status`
- `/ralphi-loop-open [loopId]`
- `/ralphi-loop-controller [loopId]`
- `/ralphi-loop-stop [loopId]`

---

## How the loop works

When you run `/ralphi-loop-start`:

1. A **controller loop** is created.
2. Runtime runs preflight validation. Loop start fails fast if required setup is missing:
   - `.ralphi/config.yaml` with `commands`
   - `.ralphi/prd.json` with valid `branchName` + `userStories`
   - git repository + pre-commit configured to run `ralphi check`
3. Runtime enforces PRD branch alignment from `.ralphi/prd.json` (`branchName`):
   - if branch exists, runtime switches to it
   - if branch is missing, TUI prompts whether to create from `main` or current branch
4. Each iteration starts in a **fresh child session**.
5. The loop skill reads:
   - `.ralphi/config.yaml`
   - `.ralphi/prd.json`
   - `.ralphi/progress.txt`
6. It implements the next pending story by priority (`status: open` / `in_progress`).
7. It signals completion via `ralphi_phase_done`.
8. Runtime finalizes the iteration and either:
   - starts another iteration, or
   - ends the loop (`complete: true`, user stop, max iterations, or no pending PRD stories).

### Iteration/session model

- Controller session tracks loop lifecycle
- Iteration sessions isolate context
- Status is persisted in `.ralphi/runtime-state.json`

---

## Commands reference

| Command | Purpose |
|---|---|
| `/ralphi-init` | Run init phase with finalize + rewind flow |
| `/ralphi-prd <name> <description>` | Run PRD generation phase |
| `/ralphi-convert <prd-file>` | Convert PRD markdown to `.ralphi/prd.json` |
| `/ralphi-finalize <runId>` | Manually finalize a run (internal/recovery) |
| `/ralphi-loop-start [--max-iterations N]` | Start autonomous loop |
| `/ralphi-loop-next <loopId>` | Trigger next iteration (internal) |
| `/ralphi-loop-stop [loopId]` | Request loop stop |
| `/ralphi-loop-open [loopId]` | Jump to active/recent iteration session |
| `/ralphi-loop-controller [loopId]` | Return to controller session |
| `/ralphi-loop-status` | Show active runs/loops |
| `/ralphi-loop-guidance-show` | Show loop guidance from config |
| `/ralphi-loop-guidance-set <guidance>` | Set `loop.guidance` in config |
| `/ralphi-loop-guidance-clear` | Clear `loop.guidance` in config |

---

## Tools reference

## `ralphi_phase_done`

Marks a phase/iteration complete and queues finalize behavior.

Required fields:
- `runId`
- `phase`
- `summary`

Optional fields:
- `outputs: string[]`
- `complete: boolean` (loop-only meaningful; set true to end loop)
- `reviewPasses: number` (loop metadata)
- `trajectory: ON_TRACK | RISK | DRIFT` (loop metadata)
- `trajectoryNotes: string`
- `correctivePlan: string` (required when strict DRIFT guard is enabled)
- `reflectionSummary: string` (required on reflection-checkpoint iterations)
- `nextIterationPlan: string` (required on reflection-checkpoint iterations)

## `ralphi_ask_user_question`

Structured interactive question tool for init/prd/convert phases.

Supports:
- single-select and multi-select
- optional `Other` free-text path
- headless `providedAnswers` for non-interactive mode

---

## Configuration (`.ralphi/config.yaml`)

Typical config:

```yaml
project:
  name: "my-project"
  language: "TypeScript"
  framework: "Pi extension"

commands:
  test: "npm run test"
  lint: "npm run lint"
  typecheck: "npm run typecheck"

rules:
  - "run npm run check before finalizing"
  - "keep changes scoped to one story"

loop:
  guidance: "Take a step back each iteration and reassess PRD alignment."
  reviewPasses: 1
  trajectoryGuard: "require_corrective_plan"
  reflectEvery: 3
  reflectInstructions: "Reassess PRD alignment, risks, and confidence before coding."

boundaries:
  never_touch:
    - "*.lock"
    - ".env*"

engine: "pi"
max_retries: 3
```

### Important sections

- `commands`: quality gates used during execution
- `rules`: injected into system prompt as project constraints
- `loop.guidance`: loop-specific steering text
- `loop.reviewPasses`: minimum expected review passes before completion
- `loop.trajectoryGuard`:
  - `off`
  - `warn_on_drift`
  - `require_corrective_plan`
- `loop.reflectEvery`: reflection checkpoint cadence in iterations (default-off when missing or `<= 0`)
- `loop.reflectInstructions`: optional project-specific checkpoint prompt content
- `boundaries.never_touch`: files/patterns that must not be modified

### Reflection checkpoints (opt-in, gradual rollout)

Reflection cadence is **disabled by default**. Enable it only when you want checkpoint iterations:

```yaml
loop:
  reflectEvery: 3
```

Checkpoint behavior:
- Every `N`th iteration (`reflectEvery`) gets a `[REFLECTION CHECKPOINT]` prompt block.
- `/ralphi-loop-status` shows countdown text (for example, `next reflection in 2 iterations`).
- At checkpoint completion, `ralphi_phase_done` must include:
  - `reflectionSummary`
  - `nextIterationPlan`

Optional custom instructions:

```yaml
loop:
  reflectEvery: 3
  reflectInstructions: "Reassess drift risk, dependencies, and confidence before implementation."
```

Suggested migration path:
1. Start with a conservative cadence (`reflectEvery: 5` or higher).
2. Run a few loops and verify the checkpoint outputs are useful.
3. Add `reflectInstructions` once your team wants a project-specific reflection template.
4. Tighten cadence (for example, `reflectEvery: 3` then `2`) only after adoption is stable.

---

## PRD data model (`.ralphi/prd.json`)

Loop expects stories in `userStories` with:
- `id`
- `title`
- `priority`
- `status` (`open` | `in_progress` | `done`)
- `dependsOn` (optional `string[]` of story IDs)

Selection behavior:
- Loop selects highest-priority **unblocked** story (dependencies satisfied).
- It prefers `status: open`, then may resume `status: in_progress`.

When all stories are `status: done`, loop can terminate.

---

## Operational tips

- Keep each story small enough for one iteration.
- Use `/ralphi-loop-open` to inspect in-flight iteration work.
- If an iteration can’t finalize, use `/ralphi-finalize <runId>`.
- Use `/ralphi-loop-status` before starting new loops.

---

## CLI helper

`ralphi` ships a project-local quality-check CLI:

```bash
npx --no-install ralphi check
```

It reads `.ralphi/config.yaml` and runs configured commands in sequence.

---

## Local development

```bash
npm install
npm run check
npm run ralphi:check
npm pack --dry-run
```

---

## Changelog

For release history and migration notes, see [`CHANGELOG.md`](./CHANGELOG.md).
