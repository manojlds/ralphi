import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type PhaseName = "ralphi-init" | "ralphi-prd" | "ralphi-convert" | "ralphi-loop-iteration";
export type NonLoopPhaseName = Exclude<PhaseName, "ralphi-loop-iteration">;
export type PhaseStatus = "running" | "awaiting_finalize" | "completed";
export type Trajectory = "ON_TRACK" | "RISK" | "DRIFT";
export type TrajectoryGuard = "off" | "warn_on_drift" | "require_corrective_plan";

export const PHASE_KINDS: readonly PhaseName[] = [
	"ralphi-init",
	"ralphi-prd",
	"ralphi-convert",
	"ralphi-loop-iteration",
] as const;

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
	reviewPasses?: number;
	trajectory?: Trajectory;
	trajectoryNotes?: string;
	correctivePlan?: string;
	reflectionSummary?: string;
	nextIterationPlan?: string;
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
	reviewPasses?: number;
	trajectory?: Trajectory;
	trajectoryNotes?: string;
	correctivePlan?: string;
	reflectionSummary?: string;
	nextIterationPlan?: string;
}

export interface LoopReviewControls {
	reviewPasses: number;
	trajectoryGuard: TrajectoryGuard;
}

export type RalphiContext = ExtensionContext | ExtensionCommandContext;
