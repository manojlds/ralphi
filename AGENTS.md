# ralphi

`ralphi` is a standalone Pi extension package for autonomous phased workflows and loop execution. It provides `/ralphi-*` commands, phase completion via `ralphi_phase_done`, and fresh-context loop control.

## Commands

Setup:
- `npm install`

After **any** code change, run:
```bash
npm run check
```

Individual commands:
- `npm run test:unit:ralphi-extension` — Run extension unit tests
- `npm run lint` — Lint TypeScript code with ESLint
- `npm run typecheck` — Run TypeScript type checks (`tsc --noEmit`)
- `npm run build` — Build TypeScript output with `tsc`

## Quality Checks

- Always run `npm run check` before finalizing changes.
- If tests touch runtime behavior, prefer adding/updating mock-based tests in `extensions/ralphi/test`.

## Conventions

- Use Vitest for tests under `extensions/ralphi/test/**/*.test.ts`.
- Keep extension command/event/tool registration in `extensions/ralphi/src`.
- Use ESM-style TypeScript imports and preserve the existing tab-indented style.
- Prefer mock-based runtime tests via `extensions/ralphi/test/factories/pi.ts`.
- Follow existing runtime/tool contract patterns (`ralphi_phase_done`, loop lifecycle handling).
- Keep project-local loop preferences in `.ralphi/config.yaml` (`loop.guidance`) and load them lazily from runtime paths so non-loop phases remain unaffected.
- For optional loop controls, configure `.ralphi/config.yaml` under `loop.*` (`reviewPasses`, `trajectoryGuard`) so defaults stay lightweight and explicit.
- When rewriting the `.ralphi/config.yaml` `loop:` section (e.g., guidance set/clear), preserve additive `loop.*` keys (such as `reflectEvery`/`reflectInstructions`) so unrelated project settings are not dropped.
- Reflection checkpoint pattern: derive cadence from `loop.reflectEvery`, inject `[REFLECTION CHECKPOINT]` prompt blocks only on checkpoint iterations, and surface countdown context in loop status text (`setStatus` + `/ralphi-loop-status`) so operators can see when the next reflection will fire.
- Reflection checkpoint metadata pattern: keep `ralphi_phase_done` fields additive/optional at schema level, then enforce checkpoint-only requirements (`reflectionSummary`, `nextIterationPlan`) inside `markPhaseDone` using shared cadence helpers so non-checkpoint and non-loop flows remain backward compatible.
- For rollout/release-safety stories, keep policy in project docs (`tasks/*.md`, `README.md`, `CHANGELOG.md`) and add markdown contract tests so sequencing/go-no-go/rollback/migration guidance does not regress silently.

## Directory Structure

```text
ralphi/
├── extensions/ralphi/      # Pi extension implementation (index, src, tests)
├── skills/                 # Skill prompts (init/prd/convert/loop)
├── .ralphi/                # Ralph loop configuration
├── package.json            # Scripts + package metadata
└── README.md               # Project overview and command list
```

## Testing Patterns

- Primary runner: Vitest (`vitest.config.ts`).
- Keep unit tests in `extensions/ralphi/test`.
- Use mocks from `extensions/ralphi/test/factories/pi.ts` for session/runtime behavior instead of requiring a live Pi session.
