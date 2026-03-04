import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type PhaseName = "ralphi-init" | "ralphi-prd" | "ralphi-convert" | "ralphi-loop-iteration";
export type NonLoopPhaseName = Exclude<PhaseName, "ralphi-loop-iteration">;
export type PhaseStatus = "running" | "awaiting_finalize" | "completed";

export const PHASE_KINDS: readonly PhaseName[] = [
	"ralphi-init",
	"ralphi-prd",
	"ralphi-convert",
	"ralphi-loop-iteration",
] as const;

/** Phases where the ralphi_ask_user_question tool is available. */
export const ASK_TOOL_PHASES: readonly PhaseName[] = ["ralphi-init", "ralphi-prd"] as const;

export interface PhaseRun {
	id: string;
	phase: PhaseName;
	status: PhaseStatus;
	sessionKey: string;
	sessionFile?: string;
	checkpointLeafId: string | null;
	checkpointSessionFile?: string;
	cwd: string;
	createdAt: string;
	summary?: string;
	outputs?: string[];
	complete?: boolean;
	loopId?: string;
	iteration?: number;
	autoConfirm: boolean;
}

export interface LoopRun {
	id: string;
	controllerSessionFile: string;
	maxIterations: number;
	iteration: number;
	active: boolean;
	stopRequested: boolean;
	createdAt: string;
	activeIterationSessionFile?: string;
	iterationSessionFiles: string[];
}

export interface PhaseDoneInput {
	runId: string;
	phase: PhaseName;
	summary: string;
	outputs?: string[];
	complete?: boolean;
}

export type RalphiContext = ExtensionContext | ExtensionCommandContext;
