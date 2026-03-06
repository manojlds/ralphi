# PRD: Three-Phase Loop Guidance and Step-Back Review for Ralphi

## 1. Introduction/Overview

Ralphi’s loop flow is already effective for one-story-per-iteration execution, but it lacks explicit, repeatable guidance for “step back and review direction” behavior.

This feature introduces a three-phase rollout to improve iteration quality and PRD alignment while preserving Ralph-style simplicity (file-based memory, single-story execution, and deterministic progress tracking). The implementation should remain consistent with Ralphi’s roots in snarktank/ralph and ralphy.

The rollout is intentionally sequential:
- **Phase 1:** Skill-level guidance + output structure
- **Phase 2:** Runtime-backed configurable loop guidance via project file
- **Phase 3:** Optional advanced review-pass controls

## 2. Goals

- Add explicit “step-back review + PRD trajectory check” behavior to every loop iteration.
- Keep loop execution aligned with PRD intent across iterations.
- Add project-local user-configurable guidance (`.ralphi/loop-guidance.md`).
- Preserve backward compatibility with existing `ralphi` loop behavior and existing `prd.json` formats.
- Add tests covering new behavior in each phase.

## 3. User Stories

### US-001: Phase 1 — Skill-level iteration review protocol
**Description:** As a maintainer, I want the `ralphi-loop` skill to require a deterministic step-back review and PRD trajectory check so that iteration quality improves without runtime complexity.

**Acceptance Criteria:**
- [x] `skills/ralphi-loop/SKILL.md` is updated with an explicit post-implementation review protocol.
- [x] The protocol requires: re-grounding in `prd.json` + `progress.txt`, code review pass, and PRD trajectory check.
- [x] Progress logging format is updated to include review outcome and trajectory fields (e.g., ON_TRACK/RISK/DRIFT).
- [x] The phase remains prompt/skill-driven only (no runtime command changes required).
- [x] Existing loop usage still functions without requiring new files.
- [x] New tests verify expected behavior and output format assumptions where testable.
- [x] Tests/typecheck/lint passes.

### US-002: Phase 2 — Project-local configurable loop guidance
**Description:** As a user, I want to define project-specific loop guidance in a local file so the agent consistently follows my review and direction preferences every iteration.

**Acceptance Criteria:**
- [x] A project-local guidance file convention is introduced at `.ralphi/loop-guidance.md`.
- [x] Runtime loads and injects guidance when present during loop iterations.
- [x] If the file is missing, runtime behavior gracefully falls back to default loop behavior.
- [x] Guidance injection is scoped to loop-relevant phases (no unintended leakage).
- [x] A command set exists to show/set/clear guidance (or equivalent project-safe UX) without manual code edits.
- [x] Tests cover guidance-present, guidance-missing, and cleanup/session-switch behavior.
- [x] Tests/typecheck/lint passes.

### US-003: Phase 3 — Optional advanced review-pass controls
**Description:** As a maintainer, I want optional review-pass controls so that teams can increase quality gates when needed without forcing extra overhead on all users.

**Acceptance Criteria:**
- [x] Optional review-pass controls are defined (e.g., `reviewPasses`, trajectory guard behavior).
- [x] Default behavior keeps current lightweight flow (advanced controls are opt-in).
- [x] If trajectory is flagged as DRIFT, loop output includes a corrective-plan signal and next-step guidance.
- [x] Completion behavior remains compatible with existing `ralphi_phase_done` contract (only additive/optional fields if needed).
- [x] Tests cover opt-in behavior and default-path backward compatibility.
- [x] Tests/typecheck/lint passes.

### US-004: Sequential rollout and release safety
**Description:** As a maintainer, I want strict phase sequencing and release gates so each phase lands safely before the next begins.

**Acceptance Criteria:**
- [x] PRD defines strict sequencing: Phase 2 cannot start until Phase 1 acceptance is complete; Phase 3 cannot start until Phase 2 acceptance is complete.
- [x] Each phase has explicit go/no-go criteria and rollback expectations.
- [x] Release notes/migration notes are defined for externally visible behavior changes.
- [x] Tests/typecheck/lint passes.

#### Phase Sequencing and Release Gates (US-004)

| Phase | Start Gate (strict prerequisite) | Go Criteria | No-Go Criteria | Rollback Expectations |
| --- | --- | --- | --- | --- |
| Phase 1 — Skill-level protocol | Baseline branch green on `npm run check` | `skills/ralphi-loop/SKILL.md` protocol + format checks merged, tests green | Missing required protocol markers, failing skill-contract tests, or runtime churn beyond prompt scope | Revert skill + test changes; restore previous loop prompt behavior |
| Phase 2 — Project-local loop guidance | **Only after Phase 1 acceptance is complete** | `.ralphi/loop-guidance.md` support and loop-only injection merged; show/set/clear commands and guidance tests green | Guidance leaks into non-loop phases, missing-file fallback breaks, or command regressions | Disable guidance injection + command wiring in one revert commit; loop reverts to Phase 1 behavior |
| Phase 3 — Optional advanced controls | **Only after Phase 2 acceptance is complete** | Optional front matter controls (`reviewPasses`, `trajectoryGuard`) and DRIFT signaling merged with backward-compatible defaults | Default path no longer backward compatible, required fields become mandatory, or loop completion contract breaks | Revert advanced-control enforcement and keep guidance file body-only behavior |

**Sequential enforcement policy:**
1. Do not begin implementation for the next phase until all acceptance criteria in the current phase are complete and the story is `status: "done"` in `prd.json`.
2. Every phase completion must include a passing `npm run check` run.
3. If a no-go criterion is hit, execute rollback first, then re-scope before retrying.

## 4. Functional Requirements

- **FR-1:** The loop iteration workflow must include a mandatory step-back review checkpoint in skill instructions.
- **FR-2:** The progress reporting format must capture review result and PRD trajectory state per iteration.
- **FR-3:** The system must support project-local loop guidance from `.ralphi/loop-guidance.md`.
- **FR-4:** The runtime must inject loop guidance only in loop-relevant execution contexts.
- **FR-5:** The system must behave safely when loop guidance file is absent, malformed, or empty.
- **FR-6:** The system must provide user-facing controls for reading/updating/clearing loop guidance.
- **FR-7:** Advanced review-pass behavior must be optional and disabled by default.
- **FR-8:** Phase delivery must follow strict sequential gating with clear acceptance checks.
- **FR-9:** New functionality must include mock-based unit/integration coverage in `extensions/ralphi/test`.
- **FR-10:** All changes must pass project checks (`npm run check`).

## 5. Non-Goals (Out of Scope)

- Replacing core one-story-per-iteration Ralph loop semantics.
- Re-architecting loop persistence/state model beyond what this feature needs.
- Introducing mandatory heavy circuit-breaker logic or full autonomous orchestration rewrite.
- Changing PRD schema fundamentals beyond additive compatibility-safe updates.

## 6. Design Considerations (Optional)

- Preserve the existing Ralphi UX and command naming conventions.
- Keep defaults simple; advanced controls should be discoverable but non-intrusive.
- Maintain clear auditability in progress logs so a human can quickly assess direction.

## 7. Technical Considerations (Optional)

- Extend existing runtime hooks (`before_agent_start`, loop lifecycle points) rather than adding parallel mechanisms.
- Prefer project-local file-based configuration (`.ralphi/loop-guidance.md`) for portability and repository visibility.
- Reuse current mock/testing patterns in `extensions/ralphi/test/factories/pi.ts`.
- Ensure no regressions in session-start/session-switch cleanup behavior.

## 8. Success Metrics

- 100% of loop iterations include explicit review + trajectory statements after Phase 1 adoption.
- Guidance injection works in loop iterations when `.ralphi/loop-guidance.md` exists and is ignored safely otherwise.
- No regressions in existing command/tool flows and no breakage of current PRD loop completion mechanics.
- All related test suites pass, including new tests for behavior introduced in each phase.

## 9. Release Notes (Externally Visible Changes)

- Loop iterations now follow a required step-back review + trajectory reporting structure in `skills/ralphi-loop/SKILL.md`.
- New project-local loop guidance file: `.ralphi/loop-guidance.md`.
- New commands: `/ralphi-loop-guidance-show`, `/ralphi-loop-guidance-set`, `/ralphi-loop-guidance-clear`.
- `ralphi_phase_done` supports additive optional loop metadata (`reviewPasses`, `trajectory`, `trajectoryNotes`, `correctivePlan`).
- Optional strict review controls can be enabled via `.ralphi/loop-guidance.md` front matter.

## 10. Migration Notes

- No mandatory migration is required; existing loop workflows continue to work with defaults.
- Teams adopting guidance should create `.ralphi/loop-guidance.md` and start with body-only guidance first.
- Teams adopting strict controls should add front matter gradually:
  - Start with `trajectoryGuard: warn_on_drift`
  - Then increase `reviewPasses` only after stable pass rates
  - Move to `trajectoryGuard: require_corrective_plan` only when DRIFT handling discipline is established
- If strict controls cause friction, remove front matter keys to immediately return to default lightweight behavior.

## 11. Open Questions

- Should trajectory status taxonomy be fixed (`ON_TRACK`, `RISK`, `DRIFT`) or configurable?
- Should guidance commands live under existing `/ralphi-loop-*` namespace or a new dedicated command group?
- Should Phase 3 add optional structured output fields to `ralphi_phase_done`, or keep all advanced signals inside summary text only?
