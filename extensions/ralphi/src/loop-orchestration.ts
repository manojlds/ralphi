import type { LoopRun } from "./types";

export type LoopFinalizeOutcome = "complete" | "stopped" | "max_iterations" | "continue";

export type LoopIterationGuard =
	| { kind: "missing"; level: "error"; message: string }
	| { kind: "inactive"; level: "warning"; message: string }
	| { kind: "stop_requested"; level: "info"; message: string }
	| { kind: "max_iterations"; level: "warning"; message: string }
	| { kind: "proceed" };

export function evaluateLoopIterationGuard(loop: LoopRun | undefined, requestedLoopId: string): LoopIterationGuard {
	if (!loop) {
		return {
			kind: "missing",
			level: "error",
			message: `Loop not found: ${requestedLoopId}`,
		};
	}
	if (!loop.active) {
		return {
			kind: "inactive",
			level: "warning",
			message: `Loop ${requestedLoopId} is not active.`,
		};
	}
	if (loop.stopRequested) {
		return {
			kind: "stop_requested",
			level: "info",
			message: `Loop ${loop.id} stopped.`,
		};
	}
	if (loop.iteration >= loop.maxIterations) {
		return {
			kind: "max_iterations",
			level: "warning",
			message: `Loop ${loop.id} reached max iterations (${loop.maxIterations}).`,
		};
	}
	return { kind: "proceed" };
}

export function evaluateFinalizeOutcome(runComplete: boolean, loop: LoopRun): LoopFinalizeOutcome {
	if (runComplete) return "complete";
	if (loop.stopRequested) return "stopped";
	if (loop.iteration >= loop.maxIterations) return "max_iterations";
	return "continue";
}

export function buildLoopIterationKickoff(params: {
	loopId: string;
	runId: string;
	iteration: number;
	maxIterations: number;
	reflectionPromptBlock: string | null;
}): string {
	const { loopId, runId, iteration, maxIterations, reflectionPromptBlock } = params;
	return `Load and execute the ralphi-loop skill now.
If skill slash commands are available, you may invoke /skill:ralphi-loop.

Loop context:
- loopId: ${loopId}
- runId: ${runId}
- iteration: ${iteration}/${maxIterations}${reflectionPromptBlock ? `\n\n${reflectionPromptBlock}` : ""}`;
}

export function buildLoopIterationStartingProgress(params: {
	loopId: string;
	iteration: number;
	maxIterations: number;
	storyId?: string;
	storyTitle?: string;
	reflectionCheckpoint: boolean;
}): string {
	const storyLabel = params.storyId && params.storyTitle ? ` — ${params.storyId}: ${params.storyTitle}` : "";
	const reflectionLabel = params.reflectionCheckpoint ? " · reflection checkpoint" : "";
	return `🔁 ${params.loopId}: starting iteration ${params.iteration}/${params.maxIterations}${storyLabel}${reflectionLabel}`;
}

export function buildLoopIterationStartingNotice(params: {
	loopId: string;
	iteration: number;
	maxIterations: number;
	reflectionCheckpoint: boolean;
}): string {
	return `Loop ${params.loopId}: starting iteration ${params.iteration}/${params.maxIterations}${params.reflectionCheckpoint ? " (reflection checkpoint)" : ""}`;
}

export function buildNoPendingStoriesProgress(loop: LoopRun): string {
	return `✅ Loop ${loop.id} complete after ${loop.iteration} iteration(s) — no pending PRD stories remain.`;
}

export function buildNoSelectableStoryProgress(loop: LoopRun): string {
	return `⏸️ Loop ${loop.id} paused after ${loop.iteration} iteration(s) — pending stories remain but none are currently selectable (likely blocked dependencies).`;
}

export function buildLoopCompleteProgress(loop: LoopRun): string {
	return `✅ Loop ${loop.id} complete after ${loop.iteration} iteration(s).`;
}

export function buildLoopStoppedProgress(loop: LoopRun): string {
	return `🛑 Loop ${loop.id} stopped by user after iteration ${loop.iteration}.`;
}

export function buildLoopMaxIterationsProgress(loop: LoopRun): string {
	return `⚠️ Loop ${loop.id} reached max iterations (${loop.maxIterations}).`;
}
