# ralphi

`ralphi` is a Pi-native implementation of the **Ralph autonomous loop pattern**.

The name is literal: **Ralph + Pi = ralphi**.

It gives you a structured, repeatable workflow for planning and implementing features with fresh-context loop iterations.

---

## What ralphi does

`ralphi` provides a phased workflow plus an autonomous implementation loop:

1. **`/ralphi-init`** — initialize project config and guardrails
2. **`/ralphi-prd`** — generate PRD markdown from a feature idea
3. **`/ralphi-convert`** — convert PRD markdown into `prd.json`
4. **`/ralphi-loop-start`** — run iterative implementation against `prd.json`

Core behavior:
- Commands are namespaced under `/ralphi-*`
- Completion is driven by the `ralphi_phase_done` tool
- Loop iterations run in fresh child sessions
- `prd.json` is the source of truth for pending stories (`passes: false`)
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

### 3) Convert PRD markdown to `prd.json`

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
2. Each iteration starts in a **fresh child session**.
3. The loop skill reads:
   - `.ralphi/config.yaml`
   - `prd.json`
   - `progress.txt`
4. It implements the next pending story (`passes: false`) by priority.
5. It signals completion via `ralphi_phase_done`.
6. Runtime finalizes the iteration and either:
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
| `/ralphi-convert <prd-file>` | Convert PRD markdown to `prd.json` |
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
- `boundaries.never_touch`: files/patterns that must not be modified

---

## PRD data model (`prd.json`)

Loop expects stories in `userStories` with:
- `id`
- `title`
- `priority`
- `passes` (boolean)

The loop selects highest-priority story where `passes !== true`.

When all stories are `passes: true`, loop can terminate.

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
