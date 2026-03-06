# Changelog

All notable changes to this project are documented in this file.

## Unreleased

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
- Loop auto-completion when no `prd.json` stories remain with `passes: false`.

### Migration notes

- No hard migration is required; default loop behavior continues to work.
- If you previously used ad-hoc prompt guidance, move it to `.ralphi/config.yaml` under `loop.guidance`.
- Adopt strict controls gradually:
  1. set `loop.reviewPasses` first,
  2. use `trajectoryGuard: "warn_on_drift"`,
  3. move to `trajectoryGuard: "require_corrective_plan"` when ready.
- To return to lightweight defaults, use `loop.reviewPasses: 1` and `loop.trajectoryGuard: "off"`.
