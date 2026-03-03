# PRD: Interactive Q&A Flow for `ralphi-init` and `ralphi-prd`

## 1. Introduction / Overview

`ralphi` currently starts phases from command arguments and static kickoff prompts. This feature adds an interactive question flow so the agent can ask users structured follow-up questions during execution of `ralphi-init` and `ralphi-prd`.

The goal is to improve requirement quality and reduce back-and-forth ambiguity by introducing a dedicated ask-user-question capability inspired by `devkade/pi-ask-tool` (structured options, deterministic answers, and interactive UX).

This PRD is specifically scoped to post-command execution behavior (after initial args such as PRD name/description are provided or prompted).

## 2. Goals

- Enable interactive, structured user questioning during `ralphi-init` and `ralphi-prd` runs.
- Support both:
  - extension-level ask tool callable by the model, and
  - command/runtime UI wrappers where needed.
- Ensure deterministic, machine-readable answers are returned to the model.
- Fail clearly in non-UI/headless mode when interactive questioning is required.
- Keep implementation testable with unit tests in `extensions/ralphi/test`.

## 3. User Stories

### US-001: Structured Ask Tool for Runtime Questioning
**Description:** As an agent executing `ralphi-init` or `ralphi-prd`, I want to ask the user structured questions through a tool so that I can gather requirements consistently.

**Acceptance Criteria:**
- [ ] A new tool (for example `ralphi_ask_user_question`) is registered in the extension.
- [ ] Tool accepts one or multiple questions with IDs and options.
- [ ] Tool supports single-select and multi-select interactions.
- [ ] Tool supports an `Other` path with free-text input when needed.
- [ ] Tool returns both concise answer output and structured details keyed by question ID.
- [ ] Verify in browser (N/A for TUI) and verify in interactive Pi TUI.
- [ ] Tests/typecheck/lint passes.

### US-002: Phase-Scoped Availability (Init + PRD)
**Description:** As a maintainer, I want interactive questioning enabled only for `ralphi-init` and `ralphi-prd` so that loop/convert behavior remains unchanged.

**Acceptance Criteria:**
- [ ] Tool guidance and/or runtime contract makes ask flow available during `ralphi-init` and `ralphi-prd`.
- [ ] `ralphi-convert` and loop iteration behavior are not modified by this feature.
- [ ] Runtime/state handling continues to work with existing phase finalization flow.
- [ ] Tests/typecheck/lint passes.

### US-003: Clear Non-UI Failure Behavior
**Description:** As a user in headless mode, I want a clear failure when an interactive question is required so I know what to provide manually.

**Acceptance Criteria:**
- [ ] If UI is unavailable and question flow is required, the tool/flow fails with a clear actionable message.
- [ ] Error text tells user what to provide as arguments/input to continue.
- [ ] No silent fallback to guessed defaults.
- [ ] Tests/typecheck/lint passes.

### US-004: PRD-Focused Command Flow Compatibility
**Description:** As a user running `/ralphi-prd`, I want question flow to continue after name and description are available so that deeper discovery happens interactively.

**Acceptance Criteria:**
- [ ] Existing `/ralphi-prd` name/description collection remains intact.
- [ ] Interactive Q&A can be triggered after name/description are resolved.
- [ ] Runtime kickoff/tool guidance encourages clarifying questions before PRD generation.
- [ ] Tests/typecheck/lint passes.

## 4. Functional Requirements

- **FR-1:** The system must provide an extension tool for structured user questioning during active runs.
- **FR-2:** The tool must support question schema with stable question IDs, prompt text, and selectable options.
- **FR-3:** The tool must support both single-select and multi-select questions.
- **FR-4:** The tool must support free-text capture for `Other` responses.
- **FR-5:** The tool result must include model-friendly text plus structured machine-readable answer details.
- **FR-6:** Interactive question capability must be enabled for `ralphi-init` and `ralphi-prd`.
- **FR-7:** If UI is unavailable and interaction is required, the flow must fail with explicit guidance.
- **FR-8:** Existing run state (`running` → `awaiting_finalize` → `completed`) must remain compatible with this feature.
- **FR-9:** Extension unit tests must cover core ask flow logic and non-UI behavior.

## 5. Non-Goals (Out of Scope)

- Implementing interactive Q&A for `ralphi-convert`.
- Implementing interactive Q&A for `ralphi-loop-iteration`.
- Building a full plugin dependency manager for third-party ask extensions.
- Replacing all existing `ctx.ui.input/confirm/select` usage in unrelated commands.

## 6. Design Considerations (Optional)

- Prefer minimal UI disruption in TUI (inline or compact dialogs).
- Keep question UX fast for keyboard-only use.
- Consider reference behavior from `devkade/pi-ask-tool`:
  - structured IDs/options,
  - deterministic answer output,
  - support for multi-question flows.

## 7. Technical Considerations (Optional)

- Candidate files:
  - `extensions/ralphi/src/tools.ts` (new ask tool registration)
  - `extensions/ralphi/src/runtime.ts` (phase-scoped guidance/integration)
  - `extensions/ralphi/src/types.ts` (ask schema/result types)
  - `extensions/ralphi/test/**/*.test.ts` (unit coverage)
- Use Pi extension UI APIs (`ctx.ui.select`, `ctx.ui.input`, `ctx.ui.custom` if needed).
- Non-UI mode must return clear error text from tool execution.
- Preserve existing finalize orchestration and run bookkeeping.

## 8. Success Metrics

- Agents ask structured clarifying questions during `ralphi-init` and `ralphi-prd` in interactive sessions.
- Reduced user rework due to missing requirements in generated PRDs.
- Unit tests cover happy-path and non-UI failure path.
- No regressions in existing `ralphi` phase completion/finalization tests.

## 9. Open Questions

- Should `ralphi` implement its own ask UI entirely, or optionally leverage/install `pi-ask-tool` when available?
- What is the exact preferred result schema for answers (plain text only vs typed JSON summary + text)?
- Should there be a configurable max number of questions per ask invocation to prevent overly long interviews?
