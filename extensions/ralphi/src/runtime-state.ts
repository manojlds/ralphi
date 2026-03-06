import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopRun, PhaseRun } from "./types";

export type PersistedState = {
	phaseRuns: PhaseRun[];
	loops: LoopRun[];
	savedAt: string;
};

function asPersistedState(value: unknown): PersistedState | null {
	if (!value || typeof value !== "object") return null;
	const parsed = value as Partial<PersistedState>;
	if (!Array.isArray(parsed.phaseRuns) || !Array.isArray(parsed.loops)) return null;
	return {
		phaseRuns: parsed.phaseRuns as PhaseRun[],
		loops: parsed.loops as LoopRun[],
		savedAt: String(parsed.savedAt ?? ""),
	};
}

export function snapshotPersistedState(
	phaseRuns: ReadonlyMap<string, PhaseRun>,
	loops: ReadonlyMap<string, LoopRun>,
): PersistedState {
	return {
		phaseRuns: [...phaseRuns.values()],
		loops: [...loops.values()],
		savedAt: new Date().toISOString(),
	};
}

export function rebuildActivePhaseBySession(
	phaseRuns: ReadonlyMap<string, PhaseRun>,
	activePhaseBySession: Map<string, string>,
): void {
	activePhaseBySession.clear();
	for (const run of phaseRuns.values()) {
		if (run.status === "running") {
			activePhaseBySession.set(run.sessionKey, run.id);
		}
	}
}

export function pruneEphemeralRuntimeState(
	phaseRuns: ReadonlyMap<string, PhaseRun>,
	commandContextByRun: Map<string, unknown>,
	pendingFinalizeRuns: Set<string>,
): void {
	for (const runId of commandContextByRun.keys()) {
		if (!phaseRuns.has(runId)) {
			commandContextByRun.delete(runId);
		}
	}
	for (const runId of pendingFinalizeRuns) {
		const run = phaseRuns.get(runId);
		if (!run || run.status !== "awaiting_finalize") {
			pendingFinalizeRuns.delete(runId);
		}
	}
}

export function latestPersistedStateFromBranch(entries: unknown[], stateEntryType: string): PersistedState | null {
	let latest: PersistedState | null = null;
	for (const entry of entries as Array<Record<string, unknown>>) {
		if (entry?.type !== "custom") continue;
		if (entry?.customType !== stateEntryType) continue;
		const candidate = asPersistedState(entry?.data);
		if (!candidate) continue;
		latest = candidate;
	}
	return latest;
}

export function readPersistedStateFile(cwd: string, stateFileRelativePath: string): PersistedState | null {
	const file = path.join(cwd, stateFileRelativePath);
	try {
		const raw = fs.readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		return asPersistedState(parsed);
	} catch {
		return null;
	}
}

export function writePersistedStateFile(cwd: string, stateFileRelativePath: string, state: PersistedState): void {
	try {
		const file = path.join(cwd, stateFileRelativePath);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
		fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
		fs.renameSync(tmp, file);
	} catch {
		// best-effort mirror for cross-session visibility
	}
}

export function newerPersistedState(a: PersistedState | null, b: PersistedState | null): PersistedState | null {
	if (!a) return b;
	if (!b) return a;
	const aTime = Date.parse(a.savedAt);
	const bTime = Date.parse(b.savedAt);
	if (!Number.isFinite(aTime)) return b;
	if (!Number.isFinite(bTime)) return a;
	return bTime >= aTime ? b : a;
}

export function applyPersistedState(
	state: PersistedState | null,
	phaseRuns: Map<string, PhaseRun>,
	loops: Map<string, LoopRun>,
): void {
	phaseRuns.clear();
	loops.clear();
	if (!state) return;
	for (const run of state.phaseRuns) {
		phaseRuns.set(run.id, run);
	}
	for (const loop of state.loops) {
		loops.set(loop.id, loop);
	}
}
