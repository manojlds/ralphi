# PRD: Loop Reflection Checkpoints and Enforcement

## 1. Introduction / Overview

`ralphi` already enforces per-iteration completion and trajectory metadata, but reflection is currently always-on through static loop guidance text. We want configurable reflection checkpoints so teams can force a deeper self-review every N iterations, with explicit reflection outputs when a checkpoint is hit.

This brings the best part of cadence-based reflection from ralph-wiggum into `ralphi` while preserving `ralphi`’s stronger structured tool-contract flow.

## 2. Goals

- Add configurable reflection cadence to `.ralphi/config.yaml`.
- Trigger explicit reflection-mode instructions on scheduled checkpoint iterations.
- Require structured reflection evidence at checkpoint completion.
- Keep default behavior lightweight and backward compatible when reflection cadence is not configured.
- Make checkpoint status visible in loop status output.

## 3. User Stories

### US-001: Add reflection checkpoint config model
**Description:** As a maintainer, I want reflection cadence options in project config so that reflection behavior is configurable without code changes.

**Acceptance Criteria:**
- [ ] `.ralphi/config.yaml` loop schema supports `reflectEvery` (integer, optional) and `reflectInstructions` (string, optional).
- [ ] `reflectEvery <= 0` is treated as disabled.
- [ ] Runtime config parsing tolerates missing fields and malformed values without crashing.
- [ ] Existing loop settings (`guidance`, `reviewPasses`, `trajectoryGuard`) continue to work unchanged.
- [ ] Tests cover disabled/default behavior and valid configured behavior.
- [ ] Lint, typecheck, and unit tests pass.

### US-002: Reflection-mode prompt injection on checkpoint iterations
**Description:** As a user, I want scheduled reflection prompts during loop execution so the agent periodically reassesses trajectory instead of grinding blindly.

**Acceptance Criteria:**
- [ ] Runtime determines checkpoint iterations using `loop.reflectEvery` cadence.
- [ ] On checkpoint iterations, iteration system prompt includes a dedicated reflection block with explicit questions and required outputs.
- [ ] If `loop.reflectInstructions` is configured, it is used; otherwise a sensible default reflection template is used.
- [ ] Non-checkpoint iterations keep current prompt behavior (no reflection block).
- [ ] Loop status output includes “next reflection in N iteration(s)” when cadence is enabled.
- [ ] Tests verify prompt content for checkpoint vs non-checkpoint iterations and status rendering.
- [ ] Lint, typecheck, and unit tests pass.

### US-003: Structured checkpoint completion requirements
**Description:** As a maintainer, I want checkpoint iterations to require structured reflection output so reflection is auditable and not just narrative text.

**Acceptance Criteria:**
- [ ] `ralphi_phase_done` accepts additive optional fields for reflection metadata (e.g. `reflectionSummary`, `nextIterationPlan`) for loop iterations.
- [ ] When current iteration is a reflection checkpoint, completion fails with actionable guidance if required reflection fields are missing.
- [ ] Validation is scoped to loop iterations only and does not affect init/prd/convert phases.
- [ ] Non-checkpoint iterations do not require reflection metadata.
- [ ] Tests cover checkpoint pass/fail validation paths and non-loop safety.
- [ ] Lint, typecheck, and unit tests pass.

### US-004: Documentation and migration guidance
**Description:** As a user, I want clear docs for reflection cadence setup so I can safely enable it project-by-project.

**Acceptance Criteria:**
- [ ] README loop/config docs include `loop.reflectEvery` and `loop.reflectInstructions` usage.
- [ ] CHANGELOG includes release notes and migration notes for reflection checkpoints.
- [ ] Migration guidance documents default-off behavior and a gradual rollout recommendation.
- [ ] Lint, typecheck, and unit tests pass.

## 4. Functional Requirements

- FR-1: The system must load optional `loop.reflectEvery` and `loop.reflectInstructions` from `.ralphi/config.yaml`.
- FR-2: The system must classify each loop iteration as checkpoint/non-checkpoint based on cadence.
- FR-3: The system must inject explicit reflection instructions only on checkpoint iterations.
- FR-4: The system must enforce required reflection metadata in `ralphi_phase_done` for checkpoint iterations.
- FR-5: The system must present checkpoint timing in loop status output when enabled.

## 5. Non-Goals (Out of Scope)

- Changing the one-story-per-iteration policy.
- Introducing external evaluator agents or LLM-as-judge services.
- Replacing existing `reviewPasses` or `trajectoryGuard` controls.
- Backfilling historical reflection metadata for already completed iterations.

## 6. Design Considerations

- Reflection prompts should be concise and action-oriented.
- Reflection should not overwhelm normal iterations; only checkpoint iterations get extra protocol text.
- Status messaging should remain readable in TUI (single-line next-reflection hint is preferred).

## 7. Technical Considerations

- Runtime touchpoints likely include loop iteration context building and `ralphi_phase_done` validation logic.
- Reflection cadence should be deterministic from iteration number to keep tests predictable.
- Additive tool fields must remain backward compatible for non-checkpoint paths.

## 8. Success Metrics

- Teams can enable cadence-based reflection with config only.
- Checkpoint iterations reliably produce structured reflection fields.
- No regressions in default loop behavior when cadence is unset.
- Test suite remains green.

## 9. Open Questions

- Should reflection metadata fields be mandatory only for `complete: true` on checkpoint iterations, or for all checkpoint completions?
- Should `loop.reflectEvery` have a minimum recommended value (e.g. 3+) to reduce prompt overhead?
- Should checkpoint state be persisted explicitly, or derived purely from iteration index?
