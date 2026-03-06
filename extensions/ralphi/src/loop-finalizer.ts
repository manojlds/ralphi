import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { formatDuration } from "./time";
import {
	buildLoopCompleteProgress,
	buildLoopMaxIterationsProgress,
	buildLoopStoppedProgress,
	evaluateFinalizeOutcome,
} from "./loop-orchestration";
import type { LoopRun, PhaseRun } from "./types";

export type LoopFinalizerDeps = {
	phaseRuns: Map<string, PhaseRun>;
	loops: Map<string, LoopRun>;
	setSuppressEventRestore: (value: boolean) => void;
	persistState: (ctx: ExtensionCommandContext) => void;
	updateLoopStatusLine: (ctx: ExtensionCommandContext) => void;
	deactivateLoop: (loop: LoopRun) => void;
	appendRalphiEvent: (kind: string, data: Record<string, unknown>) => void;
	sendProgressMessage: (text: string, details?: Record<string, unknown>) => void;
	runLoopIteration: (ctx: ExtensionCommandContext, loopId: string) => Promise<void>;
	markStoryDone: (cwd: string, storyId: string) => void;
};

export class LoopFinalizer {
	constructor(private readonly deps: LoopFinalizerDeps) {}

	private async withSuppressedEventRestore<T>(run: () => Promise<T>): Promise<T> {
		this.deps.setSuppressEventRestore(true);
		try {
			return await run();
		} finally {
			this.deps.setSuppressEventRestore(false);
		}
	}

	async finalizeLoopRun(run: PhaseRun, ctx: ExtensionCommandContext) {
		run.status = "completed";
		run.completedAt = new Date().toISOString();
		this.deps.phaseRuns.set(run.id, run);

		if (!run.loopId) {
			this.deps.persistState(ctx);
			ctx.ui.notify(`Loop metadata missing for ${run.id}`, "error");
			return;
		}

		const loop = this.deps.loops.get(run.loopId);
		if (!loop) {
			this.deps.persistState(ctx);
			ctx.ui.notify(`Loop ${run.loopId} not found`, "warning");
			return;
		}

		if (ctx.sessionManager.getSessionFile() !== loop.controllerSessionFile) {
			const switchedToController = await this.withSuppressedEventRestore(async () => {
				const switched = await ctx.switchSession(loop.controllerSessionFile);
				if (switched.cancelled) {
					ctx.ui.notify("Could not switch back to loop controller session.", "error");
					return false;
				}
				return true;
			});
			if (!switchedToController) return;
		}

		const iterationElapsed = formatDuration(loop.currentIterationStartedAt, run.completedAt);
		loop.activeIterationSessionFile = undefined;
		loop.currentIterationStartedAt = undefined;
		if (run.storyId) {
			this.deps.markStoryDone(run.cwd, run.storyId);
		}
		this.deps.appendRalphiEvent("loop_iteration_finalized", {
			loopId: loop.id,
			runId: run.id,
			iteration: loop.iteration,
			storyId: run.storyId,
			storyTitle: run.storyTitle,
			sessionFile: run.sessionFile,
			summary: run.summary,
			outputs: run.outputs,
			complete: run.complete ?? false,
			reviewPasses: run.reviewPasses,
			trajectory: run.trajectory,
			trajectoryNotes: run.trajectoryNotes,
			correctivePlan: run.correctivePlan,
			reflectionSummary: run.reflectionSummary,
			nextIterationPlan: run.nextIterationPlan,
		});
		this.deps.sendProgressMessage(
			`🔁 ${loop.id}: iteration ${loop.iteration}/${loop.maxIterations} finalized${iterationElapsed ? ` in ${iterationElapsed}` : ""} — ${run.summary ?? "(no summary)"}`,
			{ loopId: loop.id, runId: run.id, iteration: loop.iteration, iterationElapsed: iterationElapsed ?? null },
		);
		if (run.trajectory === "DRIFT") {
			this.deps.sendProgressMessage(
				`⚠️ ${loop.id}: trajectory DRIFT signaled on iteration ${loop.iteration}. Next step: execute corrective plan before closing the related story.`,
				{
					loopId: loop.id,
					runId: run.id,
					iteration: loop.iteration,
					trajectory: run.trajectory,
					correctivePlan: run.correctivePlan ?? null,
				},
			);
		}
		this.deps.persistState(ctx);

		const finalizeOutcome = evaluateFinalizeOutcome(run.complete ?? false, loop);
		if (finalizeOutcome === "complete") {
			this.deps.deactivateLoop(loop);
			this.deps.updateLoopStatusLine(ctx);
			this.deps.appendRalphiEvent("loop_completed", { loopId: loop.id, iteration: loop.iteration });
			this.deps.persistState(ctx);
			const progress = buildLoopCompleteProgress(loop);
			this.deps.sendProgressMessage(progress, { loopId: loop.id, iteration: loop.iteration });
			ctx.ui.notify(progress.replace("✅ ", ""), "info");
			return;
		}

		if (finalizeOutcome === "stopped") {
			this.deps.deactivateLoop(loop);
			this.deps.updateLoopStatusLine(ctx);
			this.deps.appendRalphiEvent("loop_stopped", { loopId: loop.id, iteration: loop.iteration });
			this.deps.persistState(ctx);
			const progress = buildLoopStoppedProgress(loop);
			this.deps.sendProgressMessage(progress, { loopId: loop.id, iteration: loop.iteration });
			ctx.ui.notify(progress.replace("🛑 ", ""), "info");
			return;
		}

		if (finalizeOutcome === "max_iterations") {
			this.deps.deactivateLoop(loop);
			this.deps.updateLoopStatusLine(ctx);
			this.deps.appendRalphiEvent("loop_max_iterations", {
				loopId: loop.id,
				iteration: loop.iteration,
				maxIterations: loop.maxIterations,
			});
			this.deps.persistState(ctx);
			const progress = buildLoopMaxIterationsProgress(loop);
			this.deps.sendProgressMessage(progress, {
				loopId: loop.id,
				iteration: loop.iteration,
				maxIterations: loop.maxIterations,
			});
			ctx.ui.notify(progress.replace("⚠️ ", ""), "warning");
			return;
		}

		this.deps.updateLoopStatusLine(ctx);
		await this.deps.runLoopIteration(ctx, loop.id);
	}
}
