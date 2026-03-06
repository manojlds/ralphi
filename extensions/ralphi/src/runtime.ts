import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

// Signal to other extensions that a ralphi tree collapse is in progress.
// Well-behaved extensions can check this and skip interactive prompts.
declare global {
	var __ralphiCollapseInProgress: boolean | undefined;
}

import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { parseMaxIterations, renderOutputs } from "./helpers";
import { buildDeterministicSummary } from "./summary";
import {
	type LoopReviewControls,
	type LoopRun,
	PHASE_KINDS,
	type NonLoopPhaseName,
	type PhaseDoneInput,
	type PhaseName,
	type PhaseRun,
	type RalphiContext,
	type TrajectoryGuard,
} from "./types";

const STATE_ENTRY_TYPE = "ralphi-state";
const CHECKPOINT_ENTRY_TYPE = "ralphi-checkpoint";
const STATE_FILE_PATH = path.join(".ralphi", "runtime-state.json");
const CONFIG_FILE_PATH = path.join(".ralphi", "config.yaml");
const DEFAULT_LOOP_REVIEW_CONTROLS: LoopReviewControls = {
	reviewPasses: 1,
	trajectoryGuard: "off",
};

type LoopReflectionConfig = {
	reflectEvery: number | null;
	reflectInstructions: string | null;
};

const DEFAULT_LOOP_REFLECTION_CONFIG: LoopReflectionConfig = {
	reflectEvery: null,
	reflectInstructions: null,
};

const DEFAULT_REFLECTION_QUESTIONS = [
	"1) Are we still aligned with the active PRD story scope and acceptance criteria?",
	"2) What risks, blockers, or drift signals are emerging?",
	"3) What is the smallest high-confidence plan for the next iteration?",
].join("\n");

type ReflectionCheckpointInfo = {
	cadence: number;
	isCheckpoint: boolean;
	iterationsUntilNext: number;
	nextCheckpointIteration: number;
	instructions: string | null;
};

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

type LoopConfigData = {
	rules: string[];
	guidance: string | null;
	controls: LoopReviewControls;
	reflection: LoopReflectionConfig;
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

	private appendLoopAutoCompletionNote(cwd: string, loopId: string, iteration: number) {
		const progressPath = path.resolve(cwd, "progress.txt");
		const note = [
			`## ${new Date().toISOString()} - Loop Auto-Completion (${loopId})`,
			"- Reason: No pending PRD stories remain (all userStories have passes=true).",
			`- Iteration count at stop: ${iteration}.`,
			"---",
		].join("\n");

		try {
			if (fs.existsSync(progressPath)) {
				const existing = fs.readFileSync(progressPath, "utf8");
				const separator = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
				fs.appendFileSync(progressPath, `${separator}${note}\n`, "utf8");
				return;
			}
			fs.writeFileSync(progressPath, `${note}\n`, "utf8");
		} catch {
			// best-effort audit trail
		}
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

	private configFile(cwd: string): string {
		return path.join(cwd, CONFIG_FILE_PATH);
	}

	private readConfigYaml(cwd: string): string | null {
		const file = this.configFile(cwd);
		if (!fs.existsSync(file)) return null;

		try {
			return fs.readFileSync(file, "utf8");
		} catch {
			return null;
		}
	}

	private unquoteYaml(value: string): string {
		const trimmed = value.trim();
		if (
			(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'"))
		) {
			return trimmed.slice(1, -1);
		}
		return trimmed;
	}

	private parseTrajectoryGuard(value: string): TrajectoryGuard | null {
		const normalized = value
			.trim()
			.toLowerCase()
			.replace(/[\s-]+/g, "_");
		if (normalized === "off" || normalized === "none") return "off";
		if (normalized === "warn" || normalized === "warn_on_drift") return "warn_on_drift";
		if (
			normalized === "require" ||
			normalized === "require_plan" ||
			normalized === "require_corrective_plan"
		) {
			return "require_corrective_plan";
		}
		return null;
	}

	private parseConfigYaml(raw: string): LoopConfigData {
		const config: LoopConfigData = {
			rules: [],
			guidance: null,
			controls: { ...DEFAULT_LOOP_REVIEW_CONTROLS },
			reflection: { ...DEFAULT_LOOP_REFLECTION_CONFIG },
		};

		const lines = raw.replace(/\r\n/g, "\n").split("\n");
		let section = "";
		let loopTextTarget: "none" | "guidance" | "reflectinstructions" = "none";
		let loopTextMode: "none" | "list" | "block" = "none";
		const guidanceLines: string[] = [];
		const reflectInstructionLines: string[] = [];

		const resetLoopTextCapture = () => {
			loopTextTarget = "none";
			loopTextMode = "none";
		};

		const targetTextLines = () => {
			if (loopTextTarget === "guidance") return guidanceLines;
			if (loopTextTarget === "reflectinstructions") return reflectInstructionLines;
			return null;
		};

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const indent = line.length - line.trimStart().length;

			if (indent === 0) {
				const topLevel = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
				section = topLevel ? topLevel[1] : "";
				resetLoopTextCapture();
				continue;
			}

			if (section === "rules") {
				const listItem = trimmed.match(/^-\s+(.+)$/);
				if (listItem) {
					config.rules.push(this.unquoteYaml(listItem[1]));
				}
				continue;
			}

			if (section !== "loop") continue;

			if (indent <= 2) {
				const kv = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
				if (!kv) {
					resetLoopTextCapture();
					continue;
				}

				const key = kv[1].toLowerCase();
				const value = kv[2].trim();
				if (key === "reviewpasses") {
					const parsed = Number.parseInt(this.unquoteYaml(value), 10);
					if (Number.isFinite(parsed) && parsed > 0) {
						config.controls.reviewPasses = parsed;
					}
					resetLoopTextCapture();
					continue;
				}
				if (key === "trajectoryguard") {
					const guard = this.parseTrajectoryGuard(this.unquoteYaml(value));
					if (guard) config.controls.trajectoryGuard = guard;
					resetLoopTextCapture();
					continue;
				}
				if (key === "reflectevery") {
					const parsed = Number.parseInt(this.unquoteYaml(value), 10);
					config.reflection.reflectEvery = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
					resetLoopTextCapture();
					continue;
				}
				if (key === "guidance" || key === "reflectinstructions") {
					const normalizedKey = key as "guidance" | "reflectinstructions";
					if (!value) {
						loopTextTarget = normalizedKey;
						loopTextMode = "list";
						const linesForKey = normalizedKey === "guidance" ? guidanceLines : reflectInstructionLines;
						linesForKey.length = 0;
						continue;
					}
					if (value === "|" || value === ">") {
						loopTextTarget = normalizedKey;
						loopTextMode = "block";
						const linesForKey = normalizedKey === "guidance" ? guidanceLines : reflectInstructionLines;
						linesForKey.length = 0;
						continue;
					}

					const resolved = this.unquoteYaml(value) || null;
					if (normalizedKey === "guidance") {
						config.guidance = resolved;
					} else {
						config.reflection.reflectInstructions = resolved;
					}
					resetLoopTextCapture();
					continue;
				}
				resetLoopTextCapture();
				continue;
			}

			if (loopTextMode === "list") {
				const listItem = trimmed.match(/^-\s+(.+)$/);
				if (!listItem) continue;
				const linesForTarget = targetTextLines();
				if (linesForTarget) {
					linesForTarget.push(this.unquoteYaml(listItem[1]));
				}
				continue;
			}

			if (loopTextMode === "block" && indent >= 4) {
				const linesForTarget = targetTextLines();
				if (linesForTarget) {
					linesForTarget.push(line.slice(4));
				}
			}
		}

		if (!config.guidance && guidanceLines.length > 0) {
			const compact = guidanceLines.map((part) => part.trim()).filter(Boolean);
			config.guidance = compact.join("\n") || null;
		}
		if (!config.reflection.reflectInstructions && reflectInstructionLines.length > 0) {
			const compact = reflectInstructionLines.map((part) => part.trim()).filter(Boolean);
			config.reflection.reflectInstructions = compact.join("\n") || null;
		}

		return config;
	}

	private loadConfigData(cwd: string): LoopConfigData {
		const raw = this.readConfigYaml(cwd);
		if (!raw) {
			return {
				rules: [],
				guidance: null,
				controls: { ...DEFAULT_LOOP_REVIEW_CONTROLS },
				reflection: { ...DEFAULT_LOOP_REFLECTION_CONFIG },
			};
		}
		return this.parseConfigYaml(raw);
	}

	private hasAdvancedReviewControls(controls: LoopReviewControls): boolean {
		return controls.reviewPasses > 1 || controls.trajectoryGuard !== "off";
	}

	private hasReflectionConfig(reflection: LoopReflectionConfig): boolean {
		return reflection.reflectEvery !== null || Boolean(reflection.reflectInstructions?.trim());
	}

	private reflectionCheckpointInfo(cwd: string, iteration: number): ReflectionCheckpointInfo | null {
		const config = this.loadConfigData(cwd);
		const cadence = config.reflection.reflectEvery;
		if (!cadence || cadence <= 0) return null;

		const safeIteration = Number.isFinite(iteration) && iteration > 0 ? Math.floor(iteration) : 0;
		const remainder = safeIteration % cadence;
		const isCheckpoint = safeIteration > 0 && remainder === 0;
		const iterationsUntilNext = isCheckpoint || remainder === 0 ? cadence : cadence - remainder;
		const nextCheckpointIteration = safeIteration + iterationsUntilNext;
		const instructions = config.reflection.reflectInstructions?.trim() || null;

		return {
			cadence,
			isCheckpoint,
			iterationsUntilNext,
			nextCheckpointIteration,
			instructions,
		};
	}

	private reflectionCountdownLabel(info: ReflectionCheckpointInfo): string {
		const unit = info.iterationsUntilNext === 1 ? "iteration" : "iterations";
		if (info.isCheckpoint) {
			return `reflection checkpoint now (next in ${info.iterationsUntilNext} ${unit}, iter ${info.nextCheckpointIteration})`;
		}
		return `next reflection in ${info.iterationsUntilNext} ${unit} (iter ${info.nextCheckpointIteration})`;
	}

	private renderReflectionPromptBlock(iteration: number, info: ReflectionCheckpointInfo): string {
		const lines = [
			"[REFLECTION CHECKPOINT]",
			`Iteration ${iteration} hit loop.reflectEvery=${info.cadence}. Run a structured reflection pass before implementation continues.`,

			"",
			info.instructions
				? `Project reflection instructions (loop.reflectInstructions):\n${info.instructions}`
				: "Project reflection instructions (loop.reflectInstructions):\n(default template)",
			"",
			"Checkpoint questions (answer explicitly):",
			DEFAULT_REFLECTION_QUESTIONS,
			"",
			"Required outputs before calling ralphi_phase_done:",
			"- Reflection Summary: concise findings and confidence level",
			"- Trajectory Decision: ON_TRACK | RISK | DRIFT with rationale",
			"- Next Iteration Plan: concrete, ordered next steps",
		];
		return lines.join("\n");
	}

	private renderLoopConfigSection(
		guidance: string | null,
		controls: LoopReviewControls,
		reflection: LoopReflectionConfig,
	): string[] {
		const lines: string[] = ["loop:"];
		if (guidance && guidance.trim().length > 0) {
			lines.push(`  guidance: ${JSON.stringify(guidance.trim())}`);
		}
		lines.push(`  reviewPasses: ${controls.reviewPasses}`);
		lines.push(`  trajectoryGuard: ${JSON.stringify(controls.trajectoryGuard)}`);
		if (reflection.reflectEvery !== null) {
			lines.push(`  reflectEvery: ${reflection.reflectEvery}`);
		}
		if (reflection.reflectInstructions && reflection.reflectInstructions.trim().length > 0) {
			lines.push(`  reflectInstructions: ${JSON.stringify(reflection.reflectInstructions.trim())}`);
		}
		return lines;
	}

	private upsertLoopSection(raw: string, sectionLines: string[] | null): string {
		const normalized = raw.replace(/\r\n/g, "\n");
		const lines = normalized.split("\n");
		let start = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].trim() === "loop:") {
				start = i;
				break;
			}
		}

		if (start === -1) {
			if (!sectionLines) return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
			const trimmed = normalized.trimEnd();
			const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
			return `${prefix}${sectionLines.join("\n")}\n`;
		}

		let end = start + 1;
		for (; end < lines.length; end++) {
			const line = lines[end];
			const trimmed = line.trim();
			if (!trimmed) continue;
			const indent = line.length - line.trimStart().length;
			if (indent === 0) break;
		}

		const before = lines.slice(0, start);
		const after = lines.slice(end);
		const merged = sectionLines ? [...before, ...sectionLines, ...after] : [...before, ...after];
		return `${merged.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
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

	/**
	 * Returns:
	 * - true  => PRD exists and has at least one story with passes !== true
	 * - false => PRD exists and all stories are passes === true
	 * - undefined => PRD missing/unreadable/invalid shape (unknown, keep loop behavior unchanged)
	 */
	private hasRemainingPrdStories(cwd: string): boolean | undefined {
		const prdPath = path.resolve(cwd, "prd.json");
		if (!fs.existsSync(prdPath)) return undefined;

		try {
			const parsed = JSON.parse(fs.readFileSync(prdPath, "utf8")) as { userStories?: unknown };
			if (!parsed || !Array.isArray(parsed.userStories)) return undefined;

			return parsed.userStories
				.filter((story): story is Record<string, unknown> => Boolean(story) && typeof story === "object")
				.some((story) => story.passes !== true);
		} catch {
			return undefined;
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
			const reflectionInfo = this.reflectionCheckpointInfo(ctx.cwd, loop.iteration);
			const reflectionSuffix = reflectionInfo ? ` · ${this.reflectionCountdownLabel(reflectionInfo)}` : "";
			const stoppingSuffix = loop.stopRequested ? " · stopping" : "";
			ctx.ui.setStatus("ralphi-loop", `🔁 ${loop.id} ${loop.iteration}/${loop.maxIterations}${reflectionSuffix}${stoppingSuffix}`);
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
			globalThis.__ralphiCollapseInProgress = true;
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
				globalThis.__ralphiCollapseInProgress = false;
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
			reviewPasses: run.reviewPasses,
			trajectory: run.trajectory,
			trajectoryNotes: run.trajectoryNotes,
			correctivePlan: run.correctivePlan,
		});
		this.sendProgressMessage(
			`🔁 ${loop.id}: iteration ${loop.iteration}/${loop.maxIterations} finalized — ${run.summary ?? "(no summary)"}`,
			{ loopId: loop.id, runId: run.id, iteration: loop.iteration },
		);
		if (run.trajectory === "DRIFT") {
			this.sendProgressMessage(
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

		if (!ctx.isIdle()) {
			ctx.ui.notify("Agent is busy — wait for it to finish before starting a ralphi phase.", "error");
			return;
		}

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
		const hasRemainingStories = this.hasRemainingPrdStories(ctx.cwd);
		if (hasRemainingStories === false) {
			loop.active = false;
			loop.activeIterationSessionFile = undefined;
			this.updateLoopStatusLine(ctx);
			this.appendRalphiEvent("loop_completed_no_pending_stories", {
				loopId: loop.id,
				iteration: loop.iteration,
			});
			this.appendLoopAutoCompletionNote(ctx.cwd, loop.id, loop.iteration);
			this.persistState(ctx);
			this.sendProgressMessage(
				`✅ Loop ${loop.id} complete after ${loop.iteration} iteration(s) — no pending PRD stories remain.`,
				{ loopId: loop.id, iteration: loop.iteration },
			);
			ctx.ui.notify(`Loop ${loop.id} complete after ${loop.iteration} iteration(s).`, "info");
			return;
		}

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

		const reflectionInfo = this.reflectionCheckpointInfo(ctx.cwd, loop.iteration);
		const reflectionPromptBlock =
			reflectionInfo?.isCheckpoint ? this.renderReflectionPromptBlock(loop.iteration, reflectionInfo) : null;
		const kickoff = `Load and execute the ralphi-loop skill now.
If skill slash commands are available, you may invoke /skill:ralphi-loop.

Loop context:
- loopId: ${loop.id}
- runId: ${run.id}
- iteration: ${loop.iteration}/${loop.maxIterations}${reflectionPromptBlock ? `\n\n${reflectionPromptBlock}` : ""}`;

		const storyLabel = pendingStory ? ` — ${pendingStory.id}: ${pendingStory.title}` : "";
		const reflectionLabel = reflectionInfo?.isCheckpoint ? " · reflection checkpoint" : "";
		this.sendProgressMessage(
			`🔁 ${loop.id}: starting iteration ${loop.iteration}/${loop.maxIterations}${storyLabel}${reflectionLabel}`,
			{ loopId: loop.id, runId, iteration: loop.iteration, storyId: pendingStory?.id, reflectionCheckpoint: reflectionInfo?.isCheckpoint ?? false },
		);
		ctx.ui.notify(
			`Loop ${loop.id}: starting iteration ${loop.iteration}/${loop.maxIterations}${reflectionInfo?.isCheckpoint ? " (reflection checkpoint)" : ""}`,
			"info",
		);
		this.updateLoopStatusLine(ctx);
		this.sendUserMessage(ctx, kickoff, "steer");
	}

	async startLoop(ctx: ExtensionCommandContext, args: string) {
		this.restoreStateFromSession(ctx);

		if (!ctx.isIdle()) {
			ctx.ui.notify("Agent is busy — wait for it to finish before starting a ralphi loop.", "error");
			return;
		}

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
				const reflectionInfo = this.reflectionCheckpointInfo(ctx.cwd, loop.iteration);
				const reflectionSuffix = reflectionInfo ? ` · ${this.reflectionCountdownLabel(reflectionInfo)}` : "";
				lines.push(`- ${loop.id}: iteration ${loop.iteration}/${loop.maxIterations}${loop.stopRequested ? " (stop requested)" : ""}${reflectionSuffix}`);
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

	showLoopGuidance(ctx: ExtensionCommandContext) {
		const config = this.loadConfigData(ctx.cwd);
		const hasReflection = this.hasReflectionConfig(config.reflection);
		const hasAdvancedControls = this.hasAdvancedReviewControls(config.controls);
		if (!config.guidance && !hasReflection && !hasAdvancedControls) {
			ctx.ui.notify(`No loop guidance configured in ${CONFIG_FILE_PATH} (loop.guidance).`, "info");
			return;
		}

		ctx.ui.notify(
			[
				`Loop guidance (${CONFIG_FILE_PATH}):`,
				config.guidance ?? "(none)",
				"",
				`reviewPasses: ${config.controls.reviewPasses}`,
				`trajectoryGuard: ${config.controls.trajectoryGuard}`,
				`reflectEvery: ${config.reflection.reflectEvery ?? "disabled"}`,
				`reflectInstructions: ${config.reflection.reflectInstructions?.trim() || "(default)"}`,
			].join("\n"),
			"info",
		);
	}

	async setLoopGuidance(ctx: ExtensionCommandContext, args: string) {
		let guidance = args.trim();
		if (!guidance) {
			if (!ctx.hasUI) {
				ctx.ui.notify("Usage: /ralphi-loop-guidance-set <guidance>", "warning");
				return;
			}

			const entered = await ctx.ui.input("Loop guidance", "Guidance injected into ralphi-loop iterations");
			guidance = entered?.trim() ?? "";
			if (!guidance) {
				ctx.ui.notify("Loop guidance was not updated (empty input).", "warning");
				return;
			}
		}

		const configFile = this.configFile(ctx.cwd);
		const existingRaw = this.readConfigYaml(ctx.cwd) ?? "";
		const configData = this.loadConfigData(ctx.cwd);
		const updated = this.upsertLoopSection(
			existingRaw,
			this.renderLoopConfigSection(guidance, configData.controls, configData.reflection),
		);
		fs.mkdirSync(path.dirname(configFile), { recursive: true });
		fs.writeFileSync(configFile, updated, "utf8");
		ctx.ui.notify(`Saved loop guidance to ${CONFIG_FILE_PATH} (loop.guidance).`, "info");
	}

	clearLoopGuidance(ctx: ExtensionCommandContext) {
		const configFile = this.configFile(ctx.cwd);
		if (!fs.existsSync(configFile)) {
			ctx.ui.notify(`No config file found at ${CONFIG_FILE_PATH}.`, "info");
			return;
		}

		const existingRaw = this.readConfigYaml(ctx.cwd) ?? "";
		const configData = this.loadConfigData(ctx.cwd);
		const keepControls = this.hasAdvancedReviewControls(configData.controls);
		const keepReflection = this.hasReflectionConfig(configData.reflection);
		const updated = this.upsertLoopSection(
			existingRaw,
			keepControls || keepReflection
				? this.renderLoopConfigSection(null, configData.controls, configData.reflection)
				: null,
		);
		fs.writeFileSync(configFile, updated, "utf8");
		ctx.ui.notify(`Cleared loop guidance in ${CONFIG_FILE_PATH}.`, "info");
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

	private loopReviewControlsForRun(run: PhaseRun): LoopReviewControls {
		if (run.phase !== "ralphi-loop-iteration") return { ...DEFAULT_LOOP_REVIEW_CONTROLS };
		return this.loadConfigData(run.cwd).controls;
	}

	private validateLoopReviewControls(run: PhaseRun, params: PhaseDoneInput): { ok: true } | { ok: false; text: string } {
		if (run.phase !== "ralphi-loop-iteration") return { ok: true };

		const controls = this.loopReviewControlsForRun(run);
		const reportedReviewPasses = params.reviewPasses ?? 1;
		if (reportedReviewPasses < controls.reviewPasses) {
			return {
				ok: false,
				text:
					`Review-pass gate not met for ${run.id}: required reviewPasses=${controls.reviewPasses}, ` +
					`received reviewPasses=${reportedReviewPasses}. ` +
					`Run additional review pass(es), then call ralphi_phase_done again. ` +
					`To disable this gate, lower loop.reviewPasses in ${CONFIG_FILE_PATH}.`,
			};
		}

		if (controls.trajectoryGuard === "require_corrective_plan" && params.trajectory === "DRIFT") {
			const correctivePlan = params.correctivePlan?.trim() ?? "";
			if (!correctivePlan) {
				return {
					ok: false,
					text:
						`Trajectory DRIFT guard is enabled for ${run.id}, but correctivePlan is missing. ` +
						`Provide correctivePlan in ralphi_phase_done, then retry.`,
				};
			}
		}

		return { ok: true };
	}

	private driftCompletionGuidance(run: PhaseRun): string | null {
		if (run.phase !== "ralphi-loop-iteration" || run.trajectory !== "DRIFT") return null;
		const plan = run.correctivePlan?.trim();
		if (plan) {
			return `Trajectory DRIFT signaled. Corrective plan captured: ${plan}. Next-step guidance: implement this plan before marking the related story as passing.`;
		}
		return "Trajectory DRIFT signaled. Corrective plan is missing. Next-step guidance: add correctivePlan + trajectoryNotes in the next ralphi_phase_done call.";
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

		const controlValidation = this.validateLoopReviewControls(run, params);
		if (!controlValidation.ok) {
			return { ok: false, text: controlValidation.text };
		}

		run.summary = params.summary;
		run.outputs = params.outputs ?? [];
		run.complete = params.complete ?? false;
		run.reviewPasses = params.reviewPasses ?? 1;
		run.trajectory = params.trajectory;
		run.trajectoryNotes = params.trajectoryNotes?.trim() || undefined;
		run.correctivePlan = params.correctivePlan?.trim() || undefined;
		run.status = "awaiting_finalize";
		this.activePhaseBySession.delete(run.sessionKey);
		this.appendRalphiEvent("phase_done_called", {
			runId: run.id,
			phase: run.phase,
			summary: run.summary,
			outputs: run.outputs,
			complete: run.complete,
			reviewPasses: run.reviewPasses,
			trajectory: run.trajectory,
			trajectoryNotes: run.trajectoryNotes,
			correctivePlan: run.correctivePlan,
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

		const baseText = `Recorded completion for ${run.phase} (${run.id}). Finalize queued for post-turn execution.`;
		const driftGuidance = this.driftCompletionGuidance(run);
		return {
			ok: true,
			text: driftGuidance ? `${baseText}\n\n⚠️ ${driftGuidance}` : baseText,
		};
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
				// No CommandContext available (e.g., lost after restart).
				// Fall back to branchWithSummary — synchronous, no events,
				// but still collapses the branch with a deterministic summary.
				const sm = ctx.sessionManager as { branchWithSummary?: (id: string | null, summary: string, details?: unknown, fromHook?: boolean) => string };
				if (run.checkpointLeafId && typeof sm.branchWithSummary === "function") {
					const summary = buildDeterministicSummary(run) ?? run.summary ?? `Phase ${run.phase} completed.`;
					sm.branchWithSummary(
						run.checkpointLeafId,
						summary,
						{ runId: run.id, phase: run.phase, fallback: true },
						true, // fromHook — marks as extension-generated
					);
					run.status = "completed";
					this.appendRalphiEvent("phase_finalized", {
						runId: run.id,
						phase: run.phase,
						summary: run.summary,
						outputs: run.outputs,
						fallback: true,
					});
					this.persistState(ctx);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Finalized ${run.phase} (${run.id}) via fallback — command context was unavailable.`,
							"info",
						);
					}
				} else if (ctx.hasUI) {
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

		let toolHint = `\n[RALPHI PHASE]\nYou are executing ${run.phase} (runId=${run.id}).\nContinue collaborating with the user until this phase is complete.\nWhen complete, call tool ralphi_phase_done with:\n{\n  \"runId\": \"${run.id}\",\n  \"phase\": \"${run.phase}\",\n  \"summary\": \"...\",\n  \"outputs\": [\"path1\", \"path2\"]\n}\nDo not call the tool early.`;

		const configData = this.loadConfigData(ctx.cwd);
		if (configData.rules.length > 0) {
			toolHint += `\n\n[PROJECT CONFIG RULES]\nRules from ${CONFIG_FILE_PATH}:\n${configData.rules.map((rule) => `- ${rule}`).join("\n")}`;
		}

		if (run.phase !== "ralphi-loop-iteration") {
			toolHint += `\n\nThe ralphi_ask_user_question tool is available to ask the user structured questions with selectable options (single/multi-select). Use it to gather requirements or clarifications interactively.`;
		}

		if (run.phase === "ralphi-loop-iteration") {
			toolHint += `\n\n[LOOP COMPLETION RULE]\nWhen calling ralphi_phase_done for loop iterations:\n- Set complete=false (or omit complete) while PRD stories remain with passes=false.\n- Set complete=true as soon as no user stories remain with passes=false in prd.json (or loop goals are fully done).`;
			if (configData.guidance) {
				toolHint += `\n\n[PROJECT LOOP GUIDANCE]\nLoop guidance found in ${CONFIG_FILE_PATH} at loop.guidance. Follow these preferences during this loop iteration unless the user explicitly overrides:\n${configData.guidance}`;
			}
			if (this.hasAdvancedReviewControls(configData.controls)) {
				toolHint += `\n\n[ADVANCED REVIEW CONTROLS]\nOptional project controls are enabled via ${CONFIG_FILE_PATH} under loop.*:\n- reviewPasses: ${configData.controls.reviewPasses}\n- trajectoryGuard: ${configData.controls.trajectoryGuard}\n\nWhen completing loop iterations with ralphi_phase_done, you may include optional fields:\n- reviewPasses (number, defaults to 1 when omitted)\n- trajectory (ON_TRACK | RISK | DRIFT)\n- trajectoryNotes (optional)\n- correctivePlan (required for DRIFT when trajectoryGuard=require_corrective_plan)`;
			}
			const reflectionInfo = this.reflectionCheckpointInfo(run.cwd, run.iteration ?? 0);
			if (reflectionInfo?.isCheckpoint) {
				toolHint += `\n\n${this.renderReflectionPromptBlock(run.iteration ?? 0, reflectionInfo)}`;
			}
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
