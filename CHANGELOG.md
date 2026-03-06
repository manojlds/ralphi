# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Release notes (three-phase loop guidance rollout)

- Phase 1: added a required loop step-back review protocol and trajectory logging format in `skills/ralphi-loop/SKILL.md`.
- Phase 2: added project-local loop guidance in `.ralphi/config.yaml` (`loop.guidance`) plus guidance management commands.
- Phase 3: added optional strict review controls in `.ralphi/config.yaml` (`loop.reviewPasses`, `loop.trajectoryGuard`) and additive loop metadata fields in `ralphi_phase_done`.
- Loop now auto-completes when no `prd.json` stories remain with `passes: false`.

### Migration notes

- No hard migration is required; default loop behavior continues to work.
- If you previously used ad-hoc prompt guidance, move it to `.ralphi/config.yaml` under `loop.guidance`.
- Adopt strict controls gradually:
  1. set `loop.reviewPasses` first,
  2. use `trajectoryGuard: "warn_on_drift"`,
  3. move to `trajectoryGuard: "require_corrective_plan"` when ready.
- To return to lightweight defaults, use `loop.reviewPasses: 1` and `loop.trajectoryGuard: "off"`.
