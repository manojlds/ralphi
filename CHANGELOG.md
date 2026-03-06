# Changelog

All notable changes to this project are documented in this file.

## Unreleased

## [0.6.1] - 2026-03-06

### Release notes (status display + Pi-native init cleanup)

- Removed the `ralphi-timing` below-editor widget to avoid duplicate status surfaces.
- Ralphi now reports loop/phase progress via status line entries only (`ralphi-loop`, `ralphi-phase`).
- Updated `ralphi-init` skill flow to be Pi-native:
  - removed engine-selection prompt
  - defaults generated config to `engine: "pi"`
  - removed Claude alias/symlink guidance from init instructions

## [0.6.0] - 2026-03-06

### Release notes (status-only PRD progression)

- Loop story progression is now status-only: `open` → `in_progress` → `done`.
- Removed runtime fallback behavior that treated legacy `passes` as source-of-truth completion state.
- Converter/loop skill docs now require `status` + `dependsOn` story metadata.

### Migration notes

- **Breaking behavior change:** update existing `.ralphi/prd.json` stories to use `status` values.
- Recommended migration: convert `passes: true` stories to `status: "done"`, and all other stories to `status: "open"` (or `"in_progress"` when actively resumed).
- Legacy `passes` fields are removed from stories as loop iterations update PRD state.

## [0.5.0] - 2026-03-06

### Release notes (runtime modularization + timing telemetry)

- Refactored `extensions/ralphi/src/runtime.ts` into focused modules:
  - `loop-config.ts`
  - `runtime-state.ts`
  - `loop-engine.ts`
  - `loop-orchestration.ts`
  - `loop-controller.ts`
  - `loop-finalizer.ts`
  - `phase-controller.ts`
- Added duration/clock utilities in `time.ts` and surfaced elapsed timing in:
  - footer status lines (`ralphi-phase`, `ralphi-loop`)
  - `/ralphi-loop-status` output
  - loop iteration finalization progress and non-loop finalize notifications
- Added a lightweight below-editor timing widget (`ralphi-timing`) showing active phase/loop elapsed time and current iteration elapsed time.
- Extended runtime models with additive timing metadata:
  - `PhaseRun.completedAt`
  - `LoopRun.completedAt`
  - `LoopRun.currentIterationStartedAt`

### Migration notes

- No migration required. Added timing fields are backward-compatible and optional.
- Existing `.ralphi/runtime-state.json` snapshots continue to load; missing timing fields are treated as unset.

## [0.4.0] - 2026-03-06

### Release notes (reflection checkpoints documentation)

- Added cadence-based reflection checkpoints in loop runtime via `loop.reflectEvery` and optional `loop.reflectInstructions`.
- Added checkpoint-only prompt injection and status countdown visibility for upcoming reflection iterations.
- Extended `ralphi_phase_done` with additive reflection metadata fields (`reflectionSummary`, `nextIterationPlan`) and checkpoint-only validation.
- Added runtime behavior to reset `.ralphi/progress.txt` when PRD branch changes and archive previous run data under `.ralphi/archive/`.
- Consolidated loop runtime artifacts under `.ralphi/*`:
  - `.ralphi/prd.json`
  - `.ralphi/progress.txt`
  - `.ralphi/.last-branch`

### Migration notes

- Reflection checkpoints are opt-in; existing projects remain unchanged unless `loop.reflectEvery` is set.
- Roll out gradually by starting with a larger cadence (for example `reflectEvery: 5`) before tightening.
- `loop.reflectInstructions` should be layered in after baseline cadence adoption.
- Runtime artifact paths have moved from project root to `.ralphi/*`; update any scripts or tooling that reference root `prd.json`, `progress.txt`, `.last-branch`, or `archive/`.

## [0.3.0] - 2026-03-06

### Release notes (three-phase loop guidance rollout)

- Phase 1: required loop step-back review protocol and trajectory logging format in `skills/ralphi-loop/SKILL.md`.
- Phase 2: project-local loop guidance in `.ralphi/config.yaml` (`loop.guidance`) plus guidance management commands.
- Phase 3: optional strict review controls in `.ralphi/config.yaml` (`loop.reviewPasses`, `loop.trajectoryGuard`) and additive loop metadata fields in `ralphi_phase_done`.
- Loop auto-completion when no unfinished `prd.json` stories remain.

### Migration notes

- No hard migration is required; default loop behavior continues to work.
- If you previously used ad-hoc prompt guidance, move it to `.ralphi/config.yaml` under `loop.guidance`.
- Adopt strict controls gradually:
  1. set `loop.reviewPasses` first,
  2. use `trajectoryGuard: "warn_on_drift"`,
  3. move to `trajectoryGuard: "require_corrective_plan"` when ready.
- To return to lightweight defaults, use `loop.reviewPasses: 1` and `loop.trajectoryGuard: "off"`.
