import { parseMaxIterations } from "./helpers";
import { formatDuration } from "./time";
import {
	activeLoop,
	buildIterationSessionName,
	findLoop,
	hasRemainingPrdStories,
	loopOptionLabel,
	markPrdStoryInProgress,
	nextPendingStory,
	sortedLoops,
} from "./loop-engine";
import { reflectionCountdownLabel, type ReflectionCheckpointInfo } from "./loop-config";
import {
	buildLoopCompleteProgress,
	buildLoopIterationKickoff,
	buildLoopIterationStartingNotice,
	buildLoopIterationStartingProgress,
	buildNoPendingStoriesProgress,
	buildNoSelectableStoryProgress,
	evaluateLoopIterationGuard,
} from "./loop-orchestration";
import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { LoopRun, PhaseRun } from "./types";

export type LoopSelection = {
	loop?: LoopRun;
	cancelled?: boolean;
};

export type LoopControllerDeps = {
	loops: Map<string, LoopRun>;
	phaseRuns: Map<string, PhaseRun>;
	activePhaseBySession: Map<string, string>;
	commandContextByRun: Map<string, ExtensionCommandContext>;
	restoreStateFromSession: (ctx: ExtensionCommandContext) => void;
	persistState: (ctx: ExtensionCommandContext) => void;
	updateLoopStatusLine: (ctx: ExtensionCommandContext) => void;
	deactivateLoop: (loop: LoopRun) => void;
	appendRalphiEvent: (kind: string, data: Record<string, unknown>) => void;
	sendProgressMessage: (text: string, details?: Record<string, unknown>) => void;
	sendUserMessage: (ctx: ExtensionCommandContext, text: string, deliveryWhenBusy?: "steer" | "followUp") => void;
	appendLoopAutoCompletionNote: (cwd: string, loopId: string, iteration: number) => void;
	ensureProgressFileForCurrentPrd: (cwd: string) => { rotated: boolean; archivePath?: string; branchName?: string };
	reflectionCheckpointInfo: (cwd: string, iteration: number) => ReflectionCheckpointInfo | null;
	renderReflectionPromptBlock: (iteration: number, info: ReflectionCheckpointInfo) => string;
	sessionKey: (ctx: ExtensionCommandContext) => string;
	shortId: (prefix: string) => string;
	setSessionName: (name: string) => void;
	setLabel: (targetId: string, label: string) => void;
	setSuppressEventRestore: (value: boolean) => void;
	prdFileName: string;
	progressFileName: string;
};

export class LoopController {
	constructor(private readonly deps: LoopControllerDeps) {}

	private async withSuppressedEventRestore<T>(run: () => Promise<T>): Promise<T> {
		this.deps.setSuppressEventRestore(true);
		try {
			return await run();
		} finally {
			this.deps.setSuppressEventRestore(false);
		}
	}

	private async resolveLoopSelection(
		ctx: ExtensionCommandContext,
		requested: string,
		selectTitle: string,
	): Promise<LoopSelection> {
		const requestedId = requested.trim();
		if (requestedId) {
			return { loop: this.deps.loops.get(requestedId) };
		}

		const loops = sortedLoops(this.deps.loops);
		if (loops.length === 0) return {};
		if (!ctx.hasUI || loops.length === 1) {
			return { loop: activeLoop(this.deps.loops) ?? loops[0] };
		}

		const optionToLoop = new Map<string, LoopRun>();
		const options = loops.map((loop) => {
			const option = loopOptionLabel(loop);
			optionToLoop.set(option, loop);
			return option;
		});

		const selected = await ctx.ui.select(selectTitle, options);
		if (!selected) return { cancelled: true };
		return { loop: optionToLoop.get(selected) };
	}

	async runLoopIteration(ctx: ExtensionCommandContext, loopId: string) {
		this.deps.restoreStateFromSession(ctx);
		const loop = this.deps.loops.get(loopId);
		if (!loop) {
			ctx.ui.notify(`Loop not found: ${loopId}`, "error");
			return;
		}

		const guard = evaluateLoopIterationGuard(loop, loopId);
		if (guard.kind === "inactive") {
			ctx.ui.notify(guard.message, guard.level);
			return;
		}
		if (guard.kind === "stop_requested") {
			this.deps.deactivateLoop(loop);
			this.deps.updateLoopStatusLine(ctx);
			this.deps.appendRalphiEvent("loop_stopped", { loopId: loop.id, iteration: loop.iteration });
			this.deps.persistState(ctx);
			ctx.ui.notify(guard.message, guard.level);
			return;
		}
		if (guard.kind === "max_iterations") {
			this.deps.deactivateLoop(loop);
			this.deps.updateLoopStatusLine(ctx);
			this.deps.appendRalphiEvent("loop_max_iterations", {
				loopId: loop.id,
				iteration: loop.iteration,
				maxIterations: loop.maxIterations,
			});
			this.deps.persistState(ctx);
			ctx.ui.notify(guard.message, guard.level);
			return;
		}

		const switchedToController = await this.withSuppressedEventRestore(async () => {
			if (ctx.sessionManager.getSessionFile() !== loop.controllerSessionFile) {
				const switched = await ctx.switchSession(loop.controllerSessionFile);
				if (switched.cancelled) {
					ctx.ui.notify("Could not switch to loop controller session.", "error");
					return false;
				}
			}
			return true;
		});
		if (!switchedToController) return;

		const nextIteration = loop.iteration + 1;
		const pendingStory = nextPendingStory(ctx.cwd, this.deps.prdFileName);
		const hasRemainingStories = hasRemainingPrdStories(ctx.cwd, this.deps.prdFileName);
		if (hasRemainingStories === false) {
			this.deps.deactivateLoop(loop);
			this.deps.updateLoopStatusLine(ctx);
			this.deps.appendRalphiEvent("loop_completed_no_pending_stories", {
				loopId: loop.id,
				iteration: loop.iteration,
			});
			this.deps.appendLoopAutoCompletionNote(ctx.cwd, loop.id, loop.iteration);
			this.deps.persistState(ctx);
			this.deps.sendProgressMessage(buildNoPendingStoriesProgress(loop), { loopId: loop.id, iteration: loop.iteration });
			ctx.ui.notify(buildLoopCompleteProgress(loop).replace("✅ ", ""), "info");
			return;
		}
		if (hasRemainingStories === true && !pendingStory) {
			this.deps.deactivateLoop(loop);
			this.deps.updateLoopStatusLine(ctx);
			this.deps.appendRalphiEvent("loop_blocked_no_selectable_story", {
				loopId: loop.id,
				iteration: loop.iteration,
			});
			this.deps.persistState(ctx);
			const progress = buildNoSelectableStoryProgress(loop);
			this.deps.sendProgressMessage(progress, { loopId: loop.id, iteration: loop.iteration });
			ctx.ui.notify(progress.replace("⏸️ ", ""), "warning");
			return;
		}

		this.deps.appendRalphiEvent("loop_iteration_starting", {
			loopId: loop.id,
			iteration: nextIteration,
			storyId: pendingStory?.id,
			storyTitle: pendingStory?.title,
		});

		const createdChildSession = await this.withSuppressedEventRestore(async () => {
			const child = await ctx.newSession({ parentSession: loop.controllerSessionFile });
			if (child.cancelled) {
				ctx.ui.notify("Creating iteration session was cancelled.", "warning");
				return false;
			}
			return true;
		});
		if (!createdChildSession) return;

		loop.iteration += 1;
		loop.currentIterationStartedAt = new Date().toISOString();
		const currentIterationSessionFile = ctx.sessionManager.getSessionFile();
		loop.activeIterationSessionFile = currentIterationSessionFile;
		if (currentIterationSessionFile) {
			loop.iterationSessionFiles.push(currentIterationSessionFile);
		}
		this.deps.setSessionName(buildIterationSessionName(loop, pendingStory));

		const key = this.deps.sessionKey(ctx);
		const runId = this.deps.shortId("iter");
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
			storyId: pendingStory?.id,
			storyTitle: pendingStory?.title,
		};

		this.deps.phaseRuns.set(runId, run);
		this.deps.commandContextByRun.set(runId, ctx);
		this.deps.activePhaseBySession.set(key, runId);
		if (pendingStory?.id) {
			markPrdStoryInProgress(ctx.cwd, this.deps.prdFileName, pendingStory.id);
		}
		this.deps.persistState(ctx);

		const reflectionInfo = this.deps.reflectionCheckpointInfo(ctx.cwd, loop.iteration);
		const reflectionPromptBlock =
			reflectionInfo?.isCheckpoint ? this.deps.renderReflectionPromptBlock(loop.iteration, reflectionInfo) : null;
		const kickoff = buildLoopIterationKickoff({
			loopId: loop.id,
			runId: run.id,
			iteration: loop.iteration,
			maxIterations: loop.maxIterations,
			reflectionPromptBlock,
		});
		const reflectionCheckpoint = reflectionInfo?.isCheckpoint ?? false;
		this.deps.sendProgressMessage(
			buildLoopIterationStartingProgress({
				loopId: loop.id,
				iteration: loop.iteration,
				maxIterations: loop.maxIterations,
				storyId: pendingStory?.id,
				storyTitle: pendingStory?.title,
				reflectionCheckpoint,
			}),
			{ loopId: loop.id, runId, iteration: loop.iteration, storyId: pendingStory?.id, reflectionCheckpoint },
		);
		ctx.ui.notify(
			buildLoopIterationStartingNotice({
				loopId: loop.id,
				iteration: loop.iteration,
				maxIterations: loop.maxIterations,
				reflectionCheckpoint,
			}),
			"info",
		);
		this.deps.updateLoopStatusLine(ctx);
		this.deps.sendUserMessage(ctx, kickoff, "steer");
	}

	async startLoop(ctx: ExtensionCommandContext, args: string) {
		this.deps.restoreStateFromSession(ctx);

		if (!ctx.isIdle()) {
			ctx.ui.notify("Agent is busy — wait for it to finish before starting a ralphi loop.", "error");
			return;
		}

		const existing = activeLoop(this.deps.loops);
		if (existing) {
			ctx.ui.notify(`Loop already active: ${existing.id}`, "warning");
			return;
		}

		const controllerSessionFile = ctx.sessionManager.getSessionFile();
		if (!controllerSessionFile) {
			ctx.ui.notify("Loop requires a persisted session file (interactive session).", "error");
			return;
		}

		const progressPrep = this.deps.ensureProgressFileForCurrentPrd(ctx.cwd);
		if (progressPrep.rotated) {
			const archiveNote = progressPrep.archivePath ? ` Archived prior run data to ${progressPrep.archivePath}.` : "";
			ctx.ui.notify(
				`Detected new PRD branch (${progressPrep.branchName ?? "unknown"}); reset ${this.deps.progressFileName} for a fresh run.${archiveNote}`,
				"info",
			);
		}

		const loopId = this.deps.shortId("loop");
		const loop: LoopRun = {
			id: loopId,
			controllerSessionFile,
			maxIterations: parseMaxIterations(args),
			iteration: 0,
			active: true,
			stopRequested: false,
			createdAt: new Date().toISOString(),
			completedAt: undefined,
			currentIterationStartedAt: undefined,
			iterationSessionFiles: [],
		};
		this.deps.loops.set(loopId, loop);

		const leaf = ctx.sessionManager.getLeafId();
		if (leaf) {
			this.deps.setLabel(leaf, `ralphi:loop:controller:${loopId}`);
		}

		this.deps.appendRalphiEvent("loop_started", { loopId: loop.id, maxIterations: loop.maxIterations });
		this.deps.persistState(ctx);
		ctx.ui.notify(`Started loop ${loop.id} (max ${loop.maxIterations} iterations)`, "info");
		this.deps.updateLoopStatusLine(ctx);
		await this.runLoopIteration(ctx, loop.id);
	}

	async stopLoop(ctx: ExtensionCommandContext, requested: string) {
		this.deps.restoreStateFromSession(ctx);
		const loop = findLoop(this.deps.loops, requested);
		if (!loop) {
			ctx.ui.notify("No active loop found.", "warning");
			return;
		}
		loop.stopRequested = true;
		this.deps.appendRalphiEvent("loop_stop_requested", { loopId: loop.id, iteration: loop.iteration });
		this.deps.persistState(ctx);
		this.deps.updateLoopStatusLine(ctx);
		ctx.ui.notify(`Stop requested for loop ${loop.id}. It will stop after current iteration finalizes.`, "info");
	}

	async openLoop(ctx: ExtensionCommandContext, requested: string) {
		this.deps.restoreStateFromSession(ctx);
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
		this.deps.restoreStateFromSession(ctx);
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
		this.deps.restoreStateFromSession(ctx);
		const activeRuns = [...this.deps.phaseRuns.values()].filter((r) => r.status !== "completed");
		const activeLoops = [...this.deps.loops.values()].filter((l) => l.active);

		if (activeRuns.length === 0 && activeLoops.length === 0) {
			ctx.ui.notify("No active ralphi runs.", "info");
			return;
		}

		const lines: string[] = [];
		if (activeLoops.length > 0) {
			lines.push("Loops:");
			for (const loop of activeLoops) {
				const reflectionInfo = this.deps.reflectionCheckpointInfo(ctx.cwd, loop.iteration);
				const reflectionSuffix = reflectionInfo ? ` · ${reflectionCountdownLabel(reflectionInfo)}` : "";
				const elapsed = formatDuration(loop.createdAt);
				const elapsedSuffix = elapsed ? ` · elapsed ${elapsed}` : "";
				const iterationElapsed = loop.currentIterationStartedAt ? formatDuration(loop.currentIterationStartedAt) : null;
				const iterationSuffix = iterationElapsed ? ` · iter ${iterationElapsed}` : "";
				lines.push(`- ${loop.id}: iteration ${loop.iteration}/${loop.maxIterations}${loop.stopRequested ? " (stop requested)" : ""}${elapsedSuffix}${iterationSuffix}${reflectionSuffix}`);
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
				const elapsed = formatDuration(run.createdAt);
				lines.push(`- ${run.id}: ${run.phase} [${run.status}]${elapsed ? ` · elapsed ${elapsed}` : ""}`);
			}
		}

		ctx.ui.notify(lines.join("\n"), "info");
	}
}
