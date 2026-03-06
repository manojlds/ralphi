# Changelog

All notable changes to this project are documented in this file.

## Unreleased

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
