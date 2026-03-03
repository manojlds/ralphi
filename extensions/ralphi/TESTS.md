# Ralphi Extension Test Plan

## Run unit tests locally

- Install dependencies: `npm install`
- Run extension unit tests: `npm run test:unit:ralphi-extension`
- Watch mode: `npm run test:unit:ralphi-extension:watch`
- The harness uses mocks in `extensions/ralphi/test/factories/pi.ts`, so tests run without a real Pi session.

## 1) Fast unit tests (no Pi runtime)

Test pure helpers in `src/helpers.ts`:

- `parseMaxIterations`
  - no flag => default 50
  - valid `--max-iterations 7`
  - invalid values (`0`, negative, non-number) => fallback 50
- `renderOutputs`
  - empty outputs => `(none declared)`
  - all files exist => `hasMissing=false`
  - missing files => `hasMissing=true`

## 2) Runtime behavior tests (with mocked context)

Mock `ExtensionCommandContext` / `ExtensionContext` and assert:

- phase lifecycle
  - `startPhase` creates run + checkpoint label + triggers skill kickoff
  - if started at empty root, extension creates a synthetic `ralphi-checkpoint` entry so finalize can still rewind
  - `markPhaseDone` transitions run to `awaiting_finalize`
  - `finalizeRun` performs rewind path (`switchSession` + `navigateTree`)
- state persistence
  - run/loop state is appended as `ralphi-state` custom entries
  - `handleSessionStart`/`handleSessionSwitch` restores state from current branch
  - finalize works after restart using restored `runId`
- loop lifecycle
  - `startLoop` creates loop and queues `/ralphi-loop-next`
  - `runLoopIteration` creates child session and sets active iteration session
  - loop stop request is honored after finalize
  - `complete: true` in `ralphi_phase_done` ends loop
- status updates
  - footer status set/cleared correctly as loop starts/stops

## 3) Command wiring tests

Check each command delegates correctly:

- `/ralphi-init`, `/ralphi-prd`, `/ralphi-convert`
- `/ralphi-loop-start`, `/ralphi-loop-next`, `/ralphi-loop-stop`
- `/ralphi-loop-open`, `/ralphi-loop-controller`, `/ralphi-loop-status`
- `/ralphi-finalize`

## 4) Tool contract tests

`ralphi_phase_done`:

- unknown run ID => error
- phase mismatch => error
- happy path => queues `/ralphi-finalize <runId>` and returns success

## 5) Smoke test in real Pi session

Manual but repeatable:

1. Install package from local path/git
2. Run `/ralphi-prd auth "Add login"`
3. Complete via `ralphi_phase_done`
4. Confirm finalize dialog appears
5. Confirm summarize+rewind returns to checkpoint
6. Start `/ralphi-loop-start --max-iterations 2`
7. Use `/ralphi-loop-open` and `/ralphi-loop-controller`
8. Verify loop status indicator and `ralphi-event` custom entries in session
