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
- Keep project-local loop preferences in `.ralphi/*` files (for example `.ralphi/loop-guidance.md`) and load them lazily from runtime paths so non-loop phases remain unaffected.
- For optional loop controls, use additive front matter in `.ralphi/loop-guidance.md` (`reviewPasses`, `trajectoryGuard`) so defaults stay lightweight and backward compatible.
- For rollout/release-safety stories, keep policy in project docs (`tasks/*.md`, `README.md`) and add markdown contract tests so sequencing/go-no-go/rollback guidance does not regress silently.

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
