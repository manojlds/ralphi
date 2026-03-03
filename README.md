# ralphi

A standalone Pi extension package for autonomous phased workflows and loop execution.

## What this is

`ralphi` is intentionally separate from `vaibhav` so loop behavior can evolve without impacting the existing `vaibhav` extension.

Key behavior:
- Commands are namespaced under `/ralphi-*`
- Completion is driven by tool calls via `ralphi_phase_done`
- Loop completion is **tool-only** (`complete: true`), not marker-text based

## Commands

- `/ralphi-init`
- `/ralphi-prd <name> [description]`
- `/ralphi-convert <prd-file>`
- `/ralphi-finalize <runId>`
- `/ralphi-loop-start [--max-iterations N]`
- `/ralphi-loop-next <loopId>`
- `/ralphi-loop-stop [loopId]`
- `/ralphi-loop-open [loopId]`
- `/ralphi-loop-controller [loopId]`
- `/ralphi-loop-status`

## Tool contract

`ralphi_phase_done`:
- `runId` (required)
- `phase` (required)
- `summary` (required)
- `outputs` (optional)
- `complete` (optional, defaults to `false`; set `true` to end loop)

## Local development

```bash
npm install
npm run test:unit:ralphi-extension
npm pack --dry-run
```
