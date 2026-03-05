# ralphi

A standalone Pi extension package for autonomous phased workflows and loop execution.

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

For developing ralphi itself, use a direct path in the **project-level** `.pi/settings.json`:

```json
{
  "packages": [
    ".."
  ]
}
```

This overrides the npm package so changes are picked up live.

## What this is

`ralphi` is intentionally separate from `vaibhav` so loop behavior can evolve without impacting the existing `vaibhav` extension.

Key behavior:
- Commands are namespaced under `/ralphi-*`
- Completion is driven by tool calls via `ralphi_phase_done`
- Loop completion is **tool-only** (`complete: true`), not marker-text based
- Loop iteration sessions are named from `prd.json` next pending story when available
- Optional project-local loop guidance is read from `.ralphi/loop-guidance.md` and injected only for loop iterations
- Optional advanced loop review controls can be enabled via `.ralphi/loop-guidance.md` front matter (`reviewPasses`, `trajectoryGuard`)

## Commands

- `/ralphi-init`
- `/ralphi-prd <name> <description>` (prompts in TUI if omitted)
- `/ralphi-convert <prd-file>`
- `/ralphi-finalize <runId>`
- `/ralphi-loop-start [--max-iterations N]`
- `/ralphi-loop-next <loopId>`
- `/ralphi-loop-stop [loopId]`
- `/ralphi-loop-open [loopId]` (interactive selector when omitted in TUI)
- `/ralphi-loop-controller [loopId]` (interactive selector when omitted in TUI)
- `/ralphi-loop-status`
- `/ralphi-loop-guidance-show`
- `/ralphi-loop-guidance-set <guidance>`
- `/ralphi-loop-guidance-clear`

## Tool contract

`ralphi_phase_done`:
- `runId` (required)
- `phase` (required)
- `summary` (required)
- `outputs` (optional)
- `complete` (optional, defaults to `false`; set `true` to end loop)
- `reviewPasses` (optional loop-only metadata; defaults to `1`)
- `trajectory` (optional loop-only metadata: `ON_TRACK | RISK | DRIFT`)
- `trajectoryNotes` (optional)
- `correctivePlan` (optional; required only when strict DRIFT guard is enabled)

`ralphi_ask_user_question`:
- `questions` (required) — array of structured questions with selectable options
- Supports single-select and multi-select with optional free-text "Other"
- Available in init, prd, and convert phases for interactive user input

Advanced review controls (optional):

```md
---
reviewPasses: 2
trajectoryGuard: require_corrective_plan
---
Prefer small, scoped changes per iteration.
```

- `reviewPasses` defaults to `1` when omitted
- `trajectoryGuard` supports `off` (default), `warn_on_drift`, or `require_corrective_plan`

## CLI

`ralphi` ships a small CLI for project-local quality checks:

```bash
npx --no-install ralphi check
```

It reads `.ralphi/config.yaml` and runs configured commands in order.

## Local development

```bash
npm install
npm run check
npm run ralphi:check
npm pack --dry-run
```
