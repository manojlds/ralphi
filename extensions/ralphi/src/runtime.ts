import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { parseMaxIterations, renderOutputs } from "./helpers";
import { buildDeterministicSummary } from "./summary";
import {
	type LoopRun,
	PHASE_KINDS,
	type NonLoopPhaseName,
	type PhaseDoneInput,
	type PhaseName,
	type PhaseRun,
	type RalphiContext,
} from "./types";

const STATE_ENTRY_TYPE = "ralphi-state";
const CHECKPOINT_ENTRY_TYPE = "ralphi-checkpoint";
const STATE_FILE_PATH = path.join(".ralphi", "runtime-state.json");

type PersistedState = {
	phaseRuns: PhaseRun[];
	loops: LoopRun[];
	savedAt: string;
};

type PendingStory = {
	id: string;
	title: string;
};

type LoopSelection = {
	loop?: LoopRun;
	cancelled?: boolean;
};

export class RalphiRuntime {
	private readonly phaseRuns = new Map<string, PhaseRun>();
	private readonly activePhaseBySession = new Map<string, string>();
	private readonly loops = new Map<string, LoopRun>();
	private readonly commandContextByRun = new Map<string, ExtensionCommandContext>();
	private readonly pendingFinalizeRuns = new Set<string>();
	private _suppressEventRestore = false;
	private currentlyFinalizingRun: PhaseRun | null = null;
	private skipNextCompact = false;

	constructor(private readonly pi: ExtensionAPI) {}

	private sessionKey(ctx: RalphiContext): string {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) return sessionFile;
		return `memory:${ctx.sessionManager.getSessionId()}`;
	}

	private shortId(prefix: string): string {
		return `${prefix}-${randomUUID().slice(0, 8)}`;
	}

	private sendUserMessage(ctx: RalphiContext, text: string, deliveryWhenBusy: "steer" | "followUp" = "steer") {
		if (ctx.isIdle()) {
			this.pi.sendUserMessage(text);
		} else {
			this.pi.sendUserMessage(text, { deliverAs: deliveryWhenBusy });
		}
	}

	private appendRalphiEvent(kind: string, data: Record<string, unknown>) {
		this.pi.appendEntry("ralphi-event", {
			kind,
			timestamp: new Date().toISOString(),
			...data,
		});
	}

	private sendProgressMessage(text: string, details?: Record<string, unknown>) {
		this.pi.sendMessage(
			{
				customType: "ralphi-progress",
				content: text,
				display: true,
				details,
			},
			{ triggerTurn: false, deliverAs: "followUp" },
		);
	}

	private snapshotState(): PersistedState {
		return {
			phaseRuns: [...this.phaseRuns.values()],
			loops: [...this.loops.values()],
			savedAt: new Date().toISOString(),
		};
	}

	private rebuildIndexes() {
		this.activePhaseBySession.clear();
		for (const run of this.phaseRuns.values()) {
			if (run.status === "running") {
				this.activePhaseBySession.set(run.sessionKey, run.id);
			}
		}
	}

	private pruneEphemeralState() {
		for (const runId of this.commandContextByRun.keys()) {
			if (!this.phaseRuns.has(runId)) {
				this.commandContextByRun.delete(runId);
			}
		}
		for (const runId of this.pendingFinalizeRuns) {
			const run = this.phaseRuns.get(runId);
			if (!run || run.status !== "awaiting_finalize") {
				this.pendingFinalizeRuns.delete(runId);
			}
		}
	}

	private findCheckpointEntryId(ctx: RalphiContext, runId: string): string | null {
		const sources = [ctx.sessionManager.getEntries(), ctx.sessionManager.getBranch()];
		for (const entries of sources) {
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as any;
				if (entry?.type !== "custom") continue;
				if (entry?.customType !== CHECKPOINT_ENTRY_TYPE) continue;
				if (entry?.data?.runId !== runId) continue;
				if (typeof entry?.id === "string" && entry.id.length > 0) return entry.id;
			}
		}
		return null;
	}

	private ensureCheckpointLeafId(ctx: RalphiContext, runId: string, phase: NonLoopPhaseName): string | null {
		const existingLeaf = ctx.sessionManager.getLeafId();
		if (existingLeaf) return existingLeaf;

		this.pi.appendEntry(CHECKPOINT_ENTRY_TYPE, {
			runId,
			phase,
			createdAt: new Date().toISOString(),
			note: "Synthetic checkpoint for ralphi phase rewind",
		});

		const leafAfterAppend = ctx.sessionManager.getLeafId();
		if (leafAfterAppend) return leafAfterAppend;

		const checkpointEntryId = this.findCheckpointEntryId(ctx, runId);
		if (checkpointEntryId) return checkpointEntryId;

		const latestEntry = ctx.sessionManager.getEntries().at(-1) as any;
		return typeof latestEntry?.id === "string" ? latestEntry.id : null;
	}

	private stateFile(cwd: string): string {
		return path.join(cwd, STATE_FILE_PATH);
	}

	private readStateFile(cwd: string): PersistedState | null {
		try {
			const raw = fs.readFileSync(this.stateFile(cwd), "utf8");
			const parsed = JSON.parse(raw) as Partial<PersistedState>;
			if (!Array.isArray(parsed.phaseRuns) || !Array.isArray(parsed.loops)) return null;
			return {
				phaseRuns: parsed.phaseRuns as PhaseRun[],
				loops: parsed.loops as LoopRun[],
				savedAt: String(parsed.savedAt ?? ""),
			};
		} catch {
			return null;
		}
	}

	private writeStateFile(cwd: string, state: PersistedState) {
		try {
			const file = this.stateFile(cwd);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
			fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
			fs.renameSync(tmp, file);
		} catch {
			// best-effort mirror for cross-session visibility
		}
	}

	private newerState(a: PersistedState | null, b: PersistedState | null): PersistedState | null {
		if (!a) return b;
		if (!b) return a;
		const aTime = Date.parse(a.savedAt);
		const bTime = Date.parse(b.savedAt);
		if (!Number.isFinite(aTime)) return b;
		if (!Number.isFinite(bTime)) return a;
		return bTime >= aTime ? b : a;
	}

	private persistState(ctx: RalphiContext) {
		const state = this.snapshotState();
		this.pi.appendEntry(STATE_ENTRY_TYPE, state);
		this.writeStateFile(ctx.cwd, state);
		this.updateLoopStatusLine(ctx);
	}

	private restoreStateFromSession(ctx: RalphiContext) {
		const branch = ctx.sessionManager.getBranch();
		let branchLatest: PersistedState | null = null;

		for (const entry of branch) {
			if (entry.type !== "custom") continue;
			if (entry.customType !== STATE_ENTRY_TYPE) continue;
			const data = entry.data as Partial<PersistedState> | undefined;
			if (!data) continue;
			if (!Array.isArray(data.phaseRuns) || !Array.isArray(data.loops)) continue;
			branchLatest = {
				phaseRuns: data.phaseRuns as PhaseRun[],
				loops: data.loops as LoopRun[],
				savedAt: String(data.savedAt ?? ""),
			};
		}

		const fileLatest = this.readStateFile(ctx.cwd);
		const latest = this.newerState(branchLatest, fileLatest);

		this.phaseRuns.clear();
		this.loops.clear();
		if (latest) {
			for (const run of latest.phaseRuns) {
				this.phaseRuns.set(run.id, run);
			}
			for (const loop of latest.loops) {
				this.loops.set(loop.id, loop);
			}
		}
		this.rebuildIndexes();
		this.pruneEphemeralState();
		this.updateLoopStatusLine(ctx);
	}

	private activeLoop(): LoopRun | undefined {
		return [...this.loops.values()].find((loop) => loop.active);
	}

	private findLoop(requested: string): LoopRun | undefined {
		if (requested.trim()) return this.loops.get(requested.trim());
		return this.activeLoop();
	}

	private sortedLoops(): LoopRun[] {
		return [...this.loops.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	private loopOptionLabel(loop: LoopRun): string {
		const state = loop.active ? "active" : "inactive";
		const stopping = loop.stopRequested ? ", stopping" : "";
		return `${loop.id} — iter ${loop.iteration}/${loop.maxIterations} (${state}${stopping})`;
	}

	private async resolveLoopSelection(
		ctx: ExtensionCommandContext,
		requested: string,
		selectTitle: string,
	): Promise<LoopSelection> {
		const requestedId = requested.trim();
		if (requestedId) {
			return { loop: this.loops.get(requestedId) };
		}

		const loops = this.sortedLoops();
		if (loops.length === 0) return {};
		if (!ctx.hasUI || loops.length === 1) {
			return { loop: this.activeLoop() ?? loops[0] };
		}

		const optionToLoop = new Map<string, LoopRun>();
		const options = loops.map((loop) => {
			const option = this.loopOptionLabel(loop);
			optionToLoop.set(option, loop);
			return option;
		});

		const selected = await ctx.ui.select(selectTitle, options);
		if (!selected) return { cancelled: true };
		return { loop: optionToLoop.get(selected) };
	}

	private parsePriority(value: unknown): number {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string") {
			const parsed = Number.parseInt(value, 10);
			if (Number.isFinite(parsed)) return parsed;
		}
		return Number.MAX_SAFE_INTEGER;
	}

	private truncateTitle(title: string, maxLength = 48): string {
		const compact = title.replace(/\s+/g, " ").trim();
		if (compact.length <= maxLength) return compact;
		return `${compact.slice(0, maxLength - 1)}…`;
	}

	private nextPendingStory(cwd: string): PendingStory | null {
		const prdPath = path.resolve(cwd, "prd.json");
		if (!fs.existsSync(prdPath)) return null;

		try {
			const parsed = JSON.parse(fs.readFileSync(prdPath, "utf8")) as { userStories?: unknown };
			if (!parsed || !Array.isArray(parsed.userStories)) return null;

			const pending = parsed.userStories
				.filter((story): story is Record<string, unknown> => Boolean(story) && typeof story === "object")
				.filter((story) => story.passes !== true)
				.map((story) => ({
					id: typeof story.id === "string" ? story.id.trim() : "",
					title: typeof story.title === "string" ? story.title.trim() : "",
					priority: this.parsePriority(story.priority),
				}))
				.filter((story) => story.id.length > 0 && story.title.length > 0)
				.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

			if (pending.length === 0) return null;
			return { id: pending[0].id, title: pending[0].title };
		} catch {
			return null;
		}
	}

	private buildIterationSessionName(loop: LoopRun, story: PendingStory | null): string {
		if (!story) return `ralphi loop ${loop.id} · iter ${loop.iteration}`;
		return `ralphi loop ${loop.id} · iter ${loop.iteration} · ${story.id} ${this.truncateTitle(story.title)}`;
	}

	private updatePhaseStatusLine(ctx: RalphiContext) {
		const key = this.sessionKey(ctx);
		const current = [...this.phaseRuns.values()]
			.filter((run) => run.sessionKey === key && run.status !== "completed")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.at(-1);
		if (!current) {
			ctx.ui.setStatus("ralphi-phase", undefined);
			return;
		}
		const status = current.status === "awaiting_finalize" ? "awaiting finalize" : "running";
		ctx.ui.setStatus("ralphi-phase", `🧩 ${current.phase} ${current.id} (${status})`);
	}

	private updateLoopStatusLine(ctx: RalphiContext) {
		const loop = this.activeLoop();
		if (!loop) {
			ctx.ui.setStatus("ralphi-loop", undefined);
		} else {
			const suffix = loop.stopRequested ? " · stopping" : "";
			ctx.ui.setStatus("ralphi-loop", `🔁 ${loop.id} ${loop.iteration}/${loop.maxIterations}${suffix}`);
		}
		this.updatePhaseStatusLine(ctx);
	}

	private async finalizeNonLoopRun(run: PhaseRun, ctx: ExtensionCommandContext) {
		const outputs = renderOutputs(run.cwd, run.outputs);
		let confirmed = true;

		if (!run.autoConfirm && ctx.hasUI) {
			const message = [
				`Phase: ${run.phase}`,
				`Run: ${run.id}`,
				"",
				"Summary:",
				run.summary ?? "(none)",
				"",
				"Outputs:",
				...outputs.lines,
				"",
				"Summarize branch and return to checkpoint?",
			].join("\n");
			confirmed = await ctx.ui.confirm("Finalize ralphi phase", message);
		}

		if (!confirmed) {
			this.appendRalphiEvent("phase_finalize_cancelled", { runId: run.id, phase: run.phase });
			this.persistState(ctx);
			ctx.ui.notify(`Finalize cancelled for ${run.id}. Run /ralphi-finalize ${run.id} again when ready.`, "info");
			return;
		}

		if (run.checkpointSessionFile && ctx.sessionManager.getSessionFile() !== run.checkpointSessionFile) {
			this._suppressEventRestore = true;
			try {
				const switched = await ctx.switchSession(run.checkpointSessionFile);
				if (switched.cancelled) {
					ctx.ui.notify("Could not switch back to checkpoint session.", "error");
					return;
				}
			} finally {
				this._suppressEventRestore = false;
			}
		}

		if (run.checkpointLeafId) {
			this.currentlyFinalizingRun = run;
			try {
				const treeResult = await ctx.navigateTree(run.checkpointLeafId, {
					summarize: true,
					label: `ralphi:${run.phase}:summary:${run.id}`,
				});
				if (treeResult.cancelled) {
					ctx.ui.notify("Tree navigation was cancelled; phase remains finalized but context was not rewound.", "warning");
				} else {
					// Skip the next auto-compact so it doesn't re-summarize
					// our deterministic summary via LLM.
					this.skipNextCompact = true;
				}
			} finally {
				this.currentlyFinalizingRun = null;
			}
		} else {
			ctx.ui.notify("No checkpoint leaf was available to rewind to.", "warning");
		}

		run.status = "completed";
		this.appendRalphiEvent("phase_finalized", {
			runId: run.id,
			phase: run.phase,
			summary: run.summary,
			outputs: run.outputs,
			missingOutputs: outputs.hasMissing,
		});
		this.persistState(ctx);
		ctx.ui.notify(
			`Finalized ${run.phase} (${run.id})${outputs.hasMissing ? " — some declared outputs are missing" : ""}`,
			outputs.hasMissing ? "warning" : "info",
		);
	}

	private async finalizeLoopRun(run: PhaseRun, ctx: ExtensionCommandContext) {
		run.status = "completed";
		this.phaseRuns.set(run.id, run);

		if (!run.loopId) {
			this.persistState(ctx);
			ctx.ui.notify(`Loop metadata missing for ${run.id}`, "error");
			return;
		}

		const loop = this.loops.get(run.loopId);
		if (!loop) {
			this.persistState(ctx);
			ctx.ui.notify(`Loop ${run.loopId} not found`, "warning");
			return;
		}

		if (ctx.sessionManager.getSessionFile() !== loop.controllerSessionFile) {
			this._suppressEventRestore = true;
			try {
				const switched = await ctx.switchSession(loop.controllerSessionFile);
				if (switched.cancelled) {
					ctx.ui.notify("Could not switch back to loop controller session.", "error");
					return;
				}
			} finally {
				this._suppressEventRestore = false;
			}
		}

		loop.activeIterationSessionFile = undefined;
		this.appendRalphiEvent("loop_iteration_finalized", {
			loopId: loop.id,
			runId: run.id,
			iteration: loop.iteration,
			sessionFile: run.sessionFile,
			summary: run.summary,
			outputs: run.outputs,
			complete: run.complete ?? false,
		});
		this.sendProgressMessage(
			`🔁 ${loop.id}: iteration ${loop.iteration}/${loop.maxIterations} finalized — ${run.summary ?? "(no summary)"}`,
			{ loopId: loop.id, runId: run.id, iteration: loop.iteration },
		);
		this.persistState(ctx);

		if (run.complete) {
			loop.active = false;
			loop.activeIterationSessionFile = undefined;
			this.updateLoopStatusLine(ctx);
			this.appendRalphiEvent("loop_completed", { loopId: loop.id, iteration: loop.iteration });
			this.persistState(ctx);
			this.sendProgressMessage(
				`✅ Loop ${loop.id} complete after ${loop.iteration} iteration(s).`,
				{ loopId: loop.id, iteration: loop.iteration },
			);
			ctx.ui.notify(`Loop ${loop.id} complete after ${loop.iteration} iteration(s).`, "info");
			return;
		}

		if (loop.stopRequested) {
			loop.active = false;
			loop.activeIterationSessionFile = undefined;
			this.updateLoopStatusLine(ctx);
			this.appendRalphiEvent("loop_stopped", { loopId: loop.id, iteration: loop.iteration });
			this.persistState(ctx);
			this.sendProgressMessage(
				`🛑 Loop ${loop.id} stopped by user after iteration ${loop.iteration}.`,
				{ loopId: loop.id, iteration: loop.iteration },
			);
			ctx.ui.notify(`Loop ${loop.id} stopped by user after iteration ${loop.iteration}.`, "info");
			return;
		}

		if (loop.iteration >= loop.maxIterations) {
			loop.active = false;
			loop.activeIterationSessionFile = undefined;
			this.updateLoopStatusLine(ctx);
			this.appendRalphiEvent("loop_max_iterations", {
				loopId: loop.id,
				iteration: loop.iteration,
				maxIterations: loop.maxIterations,
			});
			this.persistState(ctx);
			this.sendProgressMessage(
				`⚠️ Loop ${loop.id} reached max iterations (${loop.maxIterations}).`,
				{ loopId: loop.id, iteration: loop.iteration, maxIterations: loop.maxIterations },
			);
			ctx.ui.notify(`Loop ${loop.id} reached max iterations (${loop.maxIterations}).`, "warning");
			return;
		}

		this.updateLoopStatusLine(ctx);
		await this.runLoopIteration(ctx, loop.id);
	}

	async startPhase(ctx: ExtensionCommandContext, phase: NonLoopPhaseName, args: string) {
		this.restoreStateFromSession(ctx);
		const key = this.sessionKey(ctx);
		const activeRunId = this.activePhaseBySession.get(key);
		if (activeRunId) {
			ctx.ui.notify(`Another ralphi phase is already active in this session (${activeRunId}).`, "warning");
			return;
		}

		const runId = this.shortId("run");
		const checkpointLeafId = this.ensureCheckpointLeafId(ctx, runId, phase);
		const currentSessionFile = ctx.sessionManager.getSessionFile();

		const run: PhaseRun = {
			id: runId,
			phase,
			status: "running",
			sessionKey: key,
			sessionFile: currentSessionFile,
			checkpointLeafId,
			checkpointSessionFile: currentSessionFile,
			cwd: ctx.cwd,
			createdAt: new Date().toISOString(),
			autoConfirm: false,
		};

		this.phaseRuns.set(runId, run);
		this.commandContextByRun.set(runId, ctx);
		this.activePhaseBySession.set(key, runId);

		if (checkpointLeafId) {
			this.pi.setLabel(checkpointLeafId, `ralphi:${phase}:checkpoint:${runId}`);
		} else {
			ctx.ui.notify(
				`Phase ${runId} has no checkpoint leaf; finalize will complete but cannot rewind with /tree semantics.`,
				"warning",
			);
		}

		const kickoff = `Load and execute the ${phase} skill now.
If skill slash commands are available, you may invoke /skill:${phase}${args.trim().length > 0 ? ` ${args}` : ""}.

Run contract for this phase:
- Keep collaborating with the user until this phase is truly complete.
- When complete, call tool ralphi_phase_done with:
  - runId: "${runId}"
  - phase: "${phase}"
  - summary: short summary of what was completed
  - outputs: list of key files written/updated
- Only call ralphi_phase_done when the user-facing task is complete.`;

		this.appendRalphiEvent("phase_started", { runId, phase, args: args.trim() || undefined });
		this.persistState(ctx);
		ctx.ui.notify(`Started ${phase} (${runId})`, "info");
		this.sendUserMessage(ctx, kickoff, "steer");
	}

	async finalizeRun(ctx: ExtensionCommandContext, runId: string) {
		this.restoreStateFromSession(ctx);
		const run = this.phaseRuns.get(runId);
		if (!run) {
			ctx.ui.notify(`Run not found: ${runId}`, "error");
			this.pendingFinalizeRuns.delete(runId);
			this.commandContextByRun.delete(runId);
			return;
		}

		if (run.status !== "awaiting_finalize") {
			ctx.ui.notify(`Run ${runId} is not ready to finalize (status: ${run.status}).`, "warning");
			this.pendingFinalizeRuns.delete(runId);
			if (run.status === "completed") {
				this.commandContextByRun.delete(runId);
			}
			return;
		}

		if (run.phase === "ralphi-loop-iteration") {
			await this.finalizeLoopRun(run, ctx);
		} else {
			await this.finalizeNonLoopRun(run, ctx);
		}

		if (this.phaseRuns.get(runId)?.status === "completed") {
			this.pendingFinalizeRuns.delete(runId);
			this.commandContextByRun.delete(runId);
		}
	}

	async runLoopIteration(ctx: ExtensionCommandContext, loopId: string) {
		this.restoreStateFromSession(ctx);
		const loop = this.loops.get(loopId);
		if (!loop) {
			ctx.ui.notify(`Loop not found: ${loopId}`, "error");
			return;
		}
		if (!loop.active) {
			ctx.ui.notify(`Loop ${loopId} is not active.`, "warning");
			return;
		}
		if (loop.stopRequested) {
			loop.active = false;
			loop.activeIterationSessionFile = undefined;
			this.updateLoopStatusLine(ctx);
			this.appendRalphiEvent("loop_stopped", { loopId: loop.id, iteration: loop.iteration });
			this.persistState(ctx);
			ctx.ui.notify(`Loop ${loop.id} stopped.`, "info");
			return;
		}
		if (loop.iteration >= loop.maxIterations) {
			loop.active = false;
			loop.activeIterationSessionFile = undefined;
			this.updateLoopStatusLine(ctx);
			this.appendRalphiEvent("loop_max_iterations", {
				loopId: loop.id,
				iteration: loop.iteration,
				maxIterations: loop.maxIterations,
			});
			this.persistState(ctx);
			ctx.ui.notify(`Loop ${loop.id} reached max iterations (${loop.maxIterations}).`, "warning");
			return;
		}

		this._suppressEventRestore = true;
		try {
			if (ctx.sessionManager.getSessionFile() !== loop.controllerSessionFile) {
				const switched = await ctx.switchSession(loop.controllerSessionFile);
				if (switched.cancelled) {
					ctx.ui.notify("Could not switch to loop controller session.", "error");
					return;
				}
			}
		} finally {
			this._suppressEventRestore = false;
		}

		const nextIteration = loop.iteration + 1;
		const pendingStory = this.nextPendingStory(ctx.cwd);
		this.appendRalphiEvent("loop_iteration_starting", {
			loopId: loop.id,
			iteration: nextIteration,
			storyId: pendingStory?.id,
			storyTitle: pendingStory?.title,
		});

		this._suppressEventRestore = true;
		try {
			const child = await ctx.newSession({ parentSession: loop.controllerSessionFile });
			if (child.cancelled) {
				ctx.ui.notify("Creating iteration session was cancelled.", "warning");
				return;
			}
		} finally {
			this._suppressEventRestore = false;
		}

		loop.iteration += 1;
		const currentIterationSessionFile = ctx.sessionManager.getSessionFile();
		loop.activeIterationSessionFile = currentIterationSessionFile;
		if (currentIterationSessionFile) {
			loop.iterationSessionFiles.push(currentIterationSessionFile);
		}
		this.pi.setSessionName(this.buildIterationSessionName(loop, pendingStory));

		const key = this.sessionKey(ctx);
		const runId = this.shortId("iter");
		const run: PhaseRun = {
			id: runId,
			phase: "ralphi-loop-iteration",
			status: "running",
			sessionKey: key,
			sessionFile: ctx.sessionManager.getSessionFile(),
			checkpointLeafId: null,
			checkpointSessionFile: loop.controllerSessionFile,
			cwd: ctx.cwd,
			createdAt: new Date().toISOString(),
			autoConfirm: true,
			loopId: loop.id,
			iteration: loop.iteration,
		};

		this.phaseRuns.set(runId, run);
		this.commandContextByRun.set(runId, ctx);
		this.activePhaseBySession.set(key, runId);
		this.persistState(ctx);

		const kickoff = `Load and execute the ralphi-loop skill now.
If skill slash commands are available, you may invoke /skill:ralphi-loop.

Loop context:
- loopId: ${loop.id}
- runId: ${run.id}
- iteration: ${loop.iteration}/${loop.maxIterations}`;

		const storyLabel = pendingStory ? ` — ${pendingStory.id}: ${pendingStory.title}` : "";
		this.sendProgressMessage(
			`🔁 ${loop.id}: starting iteration ${loop.iteration}/${loop.maxIterations}${storyLabel}`,
			{ loopId: loop.id, runId, iteration: loop.iteration, storyId: pendingStory?.id },
		);
		ctx.ui.notify(`Loop ${loop.id}: starting iteration ${loop.iteration}/${loop.maxIterations}`, "info");
		this.updateLoopStatusLine(ctx);
		this.sendUserMessage(ctx, kickoff, "steer");
	}

	async startLoop(ctx: ExtensionCommandContext, args: string) {
		this.restoreStateFromSession(ctx);
		const existing = this.activeLoop();
		if (existing) {
			ctx.ui.notify(`Loop already active: ${existing.id}`, "warning");
			return;
		}

		const controllerSessionFile = ctx.sessionManager.getSessionFile();
		if (!controllerSessionFile) {
			ctx.ui.notify("Loop requires a persisted session file (interactive session).", "error");
			return;
		}

		const loopId = this.shortId("loop");
		const loop: LoopRun = {
			id: loopId,
			controllerSessionFile,
			maxIterations: parseMaxIterations(args),
			iteration: 0,
			active: true,
			stopRequested: false,
			createdAt: new Date().toISOString(),
			iterationSessionFiles: [],
		};
		this.loops.set(loopId, loop);

		const leaf = ctx.sessionManager.getLeafId();
		if (leaf) {
			this.pi.setLabel(leaf, `ralphi:loop:controller:${loopId}`);
		}

		this.appendRalphiEvent("loop_started", { loopId: loop.id, maxIterations: loop.maxIterations });
		this.persistState(ctx);
		ctx.ui.notify(`Started loop ${loop.id} (max ${loop.maxIterations} iterations)`, "info");
		this.updateLoopStatusLine(ctx);
		await this.runLoopIteration(ctx, loop.id);
	}

	async stopLoop(ctx: ExtensionCommandContext, requested: string) {
		this.restoreStateFromSession(ctx);
		const loop = this.findLoop(requested);
		if (!loop) {
			ctx.ui.notify("No active loop found.", "warning");
			return;
		}
		loop.stopRequested = true;
		this.appendRalphiEvent("loop_stop_requested", { loopId: loop.id, iteration: loop.iteration });
		this.persistState(ctx);
		this.updateLoopStatusLine(ctx);
		ctx.ui.notify(`Stop requested for loop ${loop.id}. It will stop after current iteration finalizes.`, "info");
	}

	async openLoop(ctx: ExtensionCommandContext, requested: string) {
		this.restoreStateFromSession(ctx);
		const selection = await this.resolveLoopSelection(ctx, requested, "Select loop to inspect");
		if (selection.cancelled) {
			ctx.ui.notify("Loop selection cancelled.", "info");
			return;
		}

		const loop = selection.loop;
		if (!loop) {
			const requestedId = requested.trim();
			ctx.ui.notify(requestedId ? `Loop not found: ${requestedId}` : "No loops found.", "warning");
			return;
		}

		const targetSessionFile = loop.activeIterationSessionFile ?? loop.iterationSessionFiles.at(-1);
		if (!targetSessionFile) {
			ctx.ui.notify("Loop has no iteration sessions yet.", "warning");
			return;
		}

		const switched = await ctx.switchSession(targetSessionFile);
		if (switched.cancelled) {
			ctx.ui.notify("Switch to loop session was cancelled.", "warning");
			return;
		}

		if (loop.activeIterationSessionFile) {
			ctx.ui.notify(`Switched to loop iteration session for ${loop.id}.`, "info");
		} else {
			ctx.ui.notify(`Switched to most recent iteration session for inactive loop ${loop.id}.`, "info");
		}
	}

	async openLoopController(ctx: ExtensionCommandContext, requested: string) {
		this.restoreStateFromSession(ctx);
		const selection = await this.resolveLoopSelection(ctx, requested, "Select loop controller");
		if (selection.cancelled) {
			ctx.ui.notify("Loop selection cancelled.", "info");
			return;
		}

		const loop = selection.loop;
		if (!loop) {
			const requestedId = requested.trim();
			ctx.ui.notify(requestedId ? `Loop not found: ${requestedId}` : "No loops found.", "warning");
			return;
		}

		const switched = await ctx.switchSession(loop.controllerSessionFile);
		if (switched.cancelled) {
			ctx.ui.notify("Switch back to controller was cancelled.", "warning");
			return;
		}
		ctx.ui.notify(`Switched to loop controller session for ${loop.id}.`, "info");
	}

	showLoopStatus(ctx: ExtensionCommandContext) {
		this.restoreStateFromSession(ctx);
		const activeRuns = [...this.phaseRuns.values()].filter((r) => r.status !== "completed");
		const activeLoops = [...this.loops.values()].filter((l) => l.active);

		if (activeRuns.length === 0 && activeLoops.length === 0) {
			ctx.ui.notify("No active ralphi runs.", "info");
			return;
		}

		const lines: string[] = [];
		if (activeLoops.length > 0) {
			lines.push("Loops:");
			for (const loop of activeLoops) {
				lines.push(`- ${loop.id}: iteration ${loop.iteration}/${loop.maxIterations}${loop.stopRequested ? " (stop requested)" : ""}`);
				if (loop.activeIterationSessionFile) {
					lines.push(`  active iteration session: ${loop.activeIterationSessionFile}`);
				}
			}
			lines.push("  use /ralphi-loop-open <loopId> to inspect active iteration session");
			lines.push("");
		}

		if (activeRuns.length > 0) {
			lines.push("Phase runs:");
			for (const run of activeRuns) {
				lines.push(`- ${run.id}: ${run.phase} [${run.status}]`);
			}
		}

		ctx.ui.notify(lines.join("\n"), "info");
	}

	private runningLoopIterationRuns(): PhaseRun[] {
		return [...this.phaseRuns.values()].filter((run) => run.phase === "ralphi-loop-iteration" && run.status === "running");
	}

	private resolveLoopIterationRunAlias(requested: string): PhaseRun | undefined {
		const requestedId = requested.trim();
		const running = this.runningLoopIterationRuns();
		if (running.length === 0) return undefined;

		const byLoopId = running.filter((run) => run.loopId === requestedId);
		if (byLoopId.length === 1) return byLoopId[0];
		if (byLoopId.length > 1) {
			return byLoopId.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
		}

		if (running.length === 1) return running[0];
		return undefined;
	}

	private runNotFoundMessage(params: PhaseDoneInput): string {
		if (params.phase !== "ralphi-loop-iteration") {
			return `Run not found: ${params.runId}`;
		}

		const running = this.runningLoopIterationRuns();
		if (running.length === 0) {
			return `Run not found: ${params.runId}. No running loop iteration found. Use the iteration runId from the loop kickoff message.`;
		}
		if (running.length === 1) {
			const only = running[0];
			return `Run not found: ${params.runId}. For this loop iteration, use runId '${only.id}'${only.loopId ? ` (loopId: ${only.loopId})` : ""}.`;
		}

		const options = running.map((run) => `${run.id}${run.loopId ? ` (loopId: ${run.loopId})` : ""}`);
		return `Run not found: ${params.runId}. Active loop iteration runIds: ${options.join(", ")}.`;
	}

	async markPhaseDone(ctx: ExtensionContext, params: PhaseDoneInput): Promise<{ ok: boolean; text: string }> {
		this.restoreStateFromSession(ctx);
		let run = this.phaseRuns.get(params.runId);
		if (!run && params.phase === "ralphi-loop-iteration") {
			run = this.resolveLoopIterationRunAlias(params.runId);
		}
		if (!run) {
			return { ok: false, text: this.runNotFoundMessage(params) };
		}

		if (run.phase !== params.phase) {
			return {
				ok: false,
				text: `Phase mismatch for run ${params.runId}: expected ${run.phase}, got ${params.phase}`,
			};
		}

		run.summary = params.summary;
		run.outputs = params.outputs ?? [];
		run.complete = params.complete ?? false;
		run.status = "awaiting_finalize";
		this.activePhaseBySession.delete(run.sessionKey);
		this.appendRalphiEvent("phase_done_called", {
			runId: run.id,
			phase: run.phase,
			summary: run.summary,
			outputs: run.outputs,
			complete: run.complete,
		});
		this.persistState(ctx);

		if (run.phase !== "ralphi-loop-iteration" && ctx.hasUI) {
			const outputs = renderOutputs(run.cwd, run.outputs);
			const confirmed = await ctx.ui.confirm(
				"Finalize ralphi phase",
				[
					`Phase: ${run.phase}`,
					`Run: ${run.id}`,
					"",
					"Summary:",
					run.summary ?? "(none)",
					"",
					"Outputs:",
					...outputs.lines,
					"",
					"Proceed with summarize + rewind now?",
				].join("\n"),
			);
			if (!confirmed) {
				this.appendRalphiEvent("phase_finalize_cancelled", { runId: run.id, phase: run.phase, source: "tool_confirm" });
				this.persistState(ctx);
				return {
					ok: true,
					text: `Completion recorded for ${run.phase} (${run.id}), but finalize was cancelled in confirmation dialog. Run /ralphi-finalize ${run.id} when ready.`,
				};
			}
			run.autoConfirm = true;
		}

		this.pendingFinalizeRuns.add(run.id);
		this.persistState(ctx);
		return { ok: true, text: `Recorded completion for ${run.phase} (${run.id}). Finalize queued for post-turn execution.` };
	}

	async handleTurnEnd(ctx: ExtensionContext) {
		this.restoreStateFromSession(ctx);
		if (this.pendingFinalizeRuns.size === 0) return;

		for (const runId of [...this.pendingFinalizeRuns]) {
			const run = this.phaseRuns.get(runId);
			if (!run || run.status !== "awaiting_finalize") {
				this.pendingFinalizeRuns.delete(runId);
				continue;
			}

			const commandCtx = this.commandContextByRun.get(runId);
			if (!commandCtx) {
				if (ctx.hasUI) {
					ctx.ui.setEditorText(`/ralphi-finalize ${runId}`);
					ctx.ui.notify(
						`Run ${runId} is awaiting finalize. Press Enter to run /ralphi-finalize ${runId}.`,
						"warning",
					);
				}
				this.pendingFinalizeRuns.delete(runId);
				continue;
			}

			await this.finalizeRun(commandCtx, runId);
			this.pendingFinalizeRuns.delete(runId);

			if (this.phaseRuns.get(runId)?.status !== "completed" && ctx.hasUI) {
				ctx.ui.setEditorText(`/ralphi-finalize ${runId}`);
				ctx.ui.notify(`Auto-finalize did not complete for ${runId}. Press Enter to retry manually.`, "warning");
			}
		}
	}

	handleSessionStart(ctx: ExtensionContext) {
		if (!this._suppressEventRestore) this.restoreStateFromSession(ctx);
	}

	handleSessionSwitch(ctx: ExtensionContext) {
		if (!this._suppressEventRestore) this.restoreStateFromSession(ctx);
	}

	handleBeforeTree(event: { preparation: { targetId: string } }): { summary: { summary: string; details: unknown } } | undefined {
		if (!this.currentlyFinalizingRun) return undefined;
		if (this.currentlyFinalizingRun.checkpointLeafId !== event.preparation.targetId) return undefined;

		const summary = buildDeterministicSummary(this.currentlyFinalizingRun);
		if (!summary) return undefined;
		return {
			summary: {
				summary,
				details: { phase: this.currentlyFinalizingRun.phase, runId: this.currentlyFinalizingRun.id },
			},
		};
	}

	handleBeforeCompact(): { cancel: boolean } | undefined {
		if (!this.skipNextCompact) return undefined;
		this.skipNextCompact = false;
		return { cancel: true };
	}

	handleBeforeAgentStart(event: BeforeAgentStartEvent, ctx: ExtensionContext): { systemPrompt: string } | void {
		const runId = this.activePhaseBySession.get(this.sessionKey(ctx));
		if (!runId) return;
		const run = this.phaseRuns.get(runId);
		if (!run || run.status !== "running") return;

		let toolHint = `\n[RALPHI PHASE]\nYou are executing ${run.phase} (runId=${run.id}).\nContinue collaborating with the user until this phase is complete.\nWhen complete, call tool ralphi_phase_done with:\n{\n  \"runId\": \"${run.id}\",\n  \"phase\": \"${run.phase}\",\n  \"summary\": \"...\",\n  \"outputs\": [\"path1\", \"path2\"]${run.phase === "ralphi-loop-iteration" ? ',\n  \"complete\": false' : ""}\n}\nDo not call the tool early.`;

		if (run.phase !== "ralphi-loop-iteration") {
			toolHint += `\n\nThe ralphi_ask_user_question tool is available to ask the user structured questions with selectable options (single/multi-select). Use it to gather requirements or clarifications interactively.`;
		}

		return {
			systemPrompt: event.systemPrompt + "\n\n" + toolHint,
		};
	}

	getActivePhaseForSession(ctx: RalphiContext): PhaseName | undefined {
		this.restoreStateFromSession(ctx);
		const key = this.sessionKey(ctx);
		const runId = this.activePhaseBySession.get(key);
		if (!runId) return undefined;
		const run = this.phaseRuns.get(runId);
		if (!run || run.status !== "running") return undefined;
		return run.phase;
	}

	phaseKinds() {
		return PHASE_KINDS;
	}
}
