import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { renderOutputs } from "./helpers";
import { formatDuration } from "./time";
import {
	type LoopConfigData,
	type LoopReflectionConfig,
	type ReflectionCheckpointInfo,
	DEFAULT_LOOP_REVIEW_CONTROLS,
	hasAdvancedLoopReviewControls as hasAdvancedReviewControlsFromConfig,
	hasReflectionConfig as hasReflectionConfigFromConfig,
	loadLoopConfigData,
	parseLoopConfigYaml,
	readLoopConfigYaml,
	renderLoopConfigSection as renderLoopConfigSectionFromConfig,
	renderReflectionPromptBlock as renderReflectionPromptBlockFromConfig,
	reflectionCheckpointInfo as reflectionCheckpointInfoFromConfig,
	reflectionCountdownLabel as reflectionCountdownLabelFromConfig,
	upsertLoopSection as upsertLoopConfigSection,
} from "./loop-config";
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
} from "./types";
import {
	type PersistedState,
	applyPersistedState,
	latestPersistedStateFromBranch,
	newerPersistedState,
	pruneEphemeralRuntimeState,
	readPersistedStateFile,
	rebuildActivePhaseBySession,
	snapshotPersistedState,
	writePersistedStateFile,
} from "./runtime-state";
import { activeLoop, markPrdStoryDone } from "./loop-engine";
import { LoopController } from "./loop-controller";
import { LoopFinalizer } from "./loop-finalizer";
import { PhaseController } from "./phase-controller";

const STATE_ENTRY_TYPE = "ralphi-state";
const CHECKPOINT_ENTRY_TYPE = "ralphi-checkpoint";
const STATE_FILE_PATH = path.join(".ralphi", "runtime-state.json");
const CONFIG_FILE_PATH = path.join(".ralphi", "config.yaml");
const PRD_FILE_NAME = path.join(".ralphi", "prd.json");
const PROGRESS_FILE_NAME = path.join(".ralphi", "progress.txt");
const LAST_BRANCH_FILE_NAME = path.join(".ralphi", ".last-branch");
const ARCHIVE_DIR_NAME = path.join(".ralphi", "archive");

export class RalphiRuntime {
	private readonly phaseRuns = new Map<string, PhaseRun>();
	private readonly activePhaseBySession = new Map<string, string>();
	private readonly loops = new Map<string, LoopRun>();
	private readonly commandContextByRun = new Map<string, ExtensionCommandContext>();
	private readonly pendingFinalizeRuns = new Set<string>();
	private _suppressEventRestore = false;
	private readonly loopController: LoopController;
	private readonly loopFinalizer: LoopFinalizer;
	private readonly phaseController: PhaseController;

	constructor(private readonly pi: ExtensionAPI) {
		this.loopController = new LoopController({
			loops: this.loops,
			phaseRuns: this.phaseRuns,
			activePhaseBySession: this.activePhaseBySession,
			commandContextByRun: this.commandContextByRun,
			restoreStateFromSession: (ctx) => this.restoreStateFromSession(ctx),
			persistState: (ctx) => this.persistState(ctx),
			updateLoopStatusLine: (ctx) => this.updateLoopStatusLine(ctx),
			deactivateLoop: (loop) => this.deactivateLoop(loop),
			appendRalphiEvent: (kind, data) => this.appendRalphiEvent(kind, data),
			sendProgressMessage: (text, details) => this.sendProgressMessage(text, details),
			sendUserMessage: (ctx, text, deliveryWhenBusy) => this.sendUserMessage(ctx, text, deliveryWhenBusy),
			appendLoopAutoCompletionNote: (cwd, loopId, iteration) => this.appendLoopAutoCompletionNote(cwd, loopId, iteration),
			ensureLoopBranch: (ctx) => this.ensureLoopBranch(ctx),
			ensureProgressFileForCurrentPrd: (cwd) => this.ensureProgressFileForCurrentPrd(cwd),
			reflectionCheckpointInfo: (cwd, iteration) => this.reflectionCheckpointInfo(cwd, iteration),
			renderReflectionPromptBlock: (iteration, info) => this.renderReflectionPromptBlock(iteration, info),
			sessionKey: (ctx) => this.sessionKey(ctx),
			shortId: (prefix) => this.shortId(prefix),
			setSessionName: (name) => this.pi.setSessionName(name),
			setLabel: (targetId, label) => this.pi.setLabel(targetId, label),
			setSuppressEventRestore: (value) => {
				this._suppressEventRestore = value;
			},
			prdFileName: PRD_FILE_NAME,
			progressFileName: PROGRESS_FILE_NAME,
		});
		this.loopFinalizer = new LoopFinalizer({
			phaseRuns: this.phaseRuns,
			loops: this.loops,
			setSuppressEventRestore: (value) => {
				this._suppressEventRestore = value;
			},
			persistState: (ctx) => this.persistState(ctx),
			updateLoopStatusLine: (ctx) => this.updateLoopStatusLine(ctx),
			deactivateLoop: (loop) => this.deactivateLoop(loop),
			appendRalphiEvent: (kind, data) => this.appendRalphiEvent(kind, data),
			sendProgressMessage: (text, details) => this.sendProgressMessage(text, details),
			runLoopIteration: (ctx, loopId) => this.loopController.runLoopIteration(ctx, loopId),
			markStoryDone: (cwd, storyId) => {
				markPrdStoryDone(cwd, PRD_FILE_NAME, storyId);
			},
		});
		this.phaseController = new PhaseController({
			phaseRuns: this.phaseRuns,
			activePhaseBySession: this.activePhaseBySession,
			commandContextByRun: this.commandContextByRun,
			restoreStateFromSession: (ctx) => this.restoreStateFromSession(ctx),
			sessionKey: (ctx) => this.sessionKey(ctx),
			shortId: (prefix) => this.shortId(prefix),
			sendUserMessage: (ctx, text, deliveryWhenBusy) => this.sendUserMessage(ctx, text, deliveryWhenBusy),
			appendRalphiEvent: (kind, data) => this.appendRalphiEvent(kind, data),
			persistState: (ctx) => this.persistState(ctx),
			setLabel: (targetId, label) => this.pi.setLabel(targetId, label),
			appendEntry: (customType, data) => this.pi.appendEntry(customType, data),
			setSuppressEventRestore: (value) => {
				this._suppressEventRestore = value;
			},
			checkpointEntryType: CHECKPOINT_ENTRY_TYPE,
		});
	}

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
		const progressPath = this.progressFile(cwd);
		const note = [
			`## ${new Date().toISOString()} - Loop Auto-Completion (${loopId})`,
			"- Reason: No pending PRD stories remain (all stories are status=done).",
			`- Iteration count at stop: ${iteration}.`,
			"---",
		].join("\n");

		try {
			fs.mkdirSync(path.dirname(progressPath), { recursive: true });
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
		return snapshotPersistedState(this.phaseRuns, this.loops);
	}

	private rebuildIndexes() {
		rebuildActivePhaseBySession(this.phaseRuns, this.activePhaseBySession);
	}

	private pruneEphemeralState() {
		pruneEphemeralRuntimeState(this.phaseRuns, this.commandContextByRun, this.pendingFinalizeRuns);
	}

	private configFile(cwd: string): string {
		return path.join(cwd, CONFIG_FILE_PATH);
	}

	private prdFile(cwd: string): string {
		return path.join(cwd, PRD_FILE_NAME);
	}

	private progressFile(cwd: string): string {
		return path.join(cwd, PROGRESS_FILE_NAME);
	}

	private lastBranchFile(cwd: string): string {
		return path.join(cwd, LAST_BRANCH_FILE_NAME);
	}

	private archiveDir(cwd: string): string {
		return path.join(cwd, ARCHIVE_DIR_NAME);
	}

	private readPrdBranchName(cwd: string): string | null {
		const prdPath = this.prdFile(cwd);
		if (!fs.existsSync(prdPath)) return null;

		try {
			const parsed = JSON.parse(fs.readFileSync(prdPath, "utf8")) as { branchName?: unknown };
			if (typeof parsed.branchName !== "string") return null;
			const branch = parsed.branchName.trim();
			return branch.length > 0 ? branch : null;
		} catch {
			return null;
		}
	}

	private runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
		const result = spawnSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			ok: result.status === 0,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	}

	private isGitRepository(cwd: string): boolean {
		const result = this.runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
		return result.ok && result.stdout.trim() === "true";
	}

	private currentGitBranch(cwd: string): string | null {
		const result = this.runGit(cwd, ["branch", "--show-current"]);
		if (!result.ok) return null;
		const branch = result.stdout.trim();
		return branch.length > 0 ? branch : null;
	}

	private localBranchExists(cwd: string, branchName: string): boolean {
		if (!branchName.trim()) return false;
		return this.runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]).ok;
	}

	private switchToBranch(cwd: string, branchName: string): boolean {
		const switched = this.runGit(cwd, ["switch", branchName]);
		if (switched.ok) return true;
		return this.runGit(cwd, ["checkout", branchName]).ok;
	}

	private createBranchFrom(cwd: string, branchName: string, baseBranch: string): boolean {
		const created = this.runGit(cwd, ["switch", "-c", branchName, baseBranch]);
		if (created.ok) return true;
		return this.runGit(cwd, ["checkout", "-b", branchName, baseBranch]).ok;
	}

	private async chooseBranchBase(
		ctx: ExtensionCommandContext,
		targetBranch: string,
		currentBranch: string | null,
	): Promise<string | null> {
		const mainExists = this.localBranchExists(ctx.cwd, "main");
		const options: Array<{ label: string; value: string }> = [];

		if (mainExists) {
			options.push({ label: "main (recommended)", value: "main" });
		}
		if (currentBranch) {
			const alreadyListed = options.some((option) => option.value === currentBranch);
			if (!alreadyListed) {
				options.push({ label: `${currentBranch} (current branch)`, value: currentBranch });
			}
		}

		if (options.length === 0) return null;
		if (!ctx.hasUI || options.length === 1) return options[0].value;

		const labels = options.map((option) => option.label);
		const selected = await ctx.ui.select(
			`Branch '${targetBranch}' does not exist. Create it from which base branch?`,
			labels,
		);
		if (!selected) return null;
		const matched = options.find((option) => option.label === selected);
		return matched?.value ?? null;
	}

	private async ensureLoopBranch(ctx: ExtensionCommandContext): Promise<boolean> {
		const targetBranch = this.readPrdBranchName(ctx.cwd);
		if (!targetBranch) return true;

		if (!this.isGitRepository(ctx.cwd)) {
			ctx.ui.notify(
				`No git repository detected in ${ctx.cwd}; cannot enforce PRD branch '${targetBranch}' automatically.`,
				"warning",
			);
			return true;
		}

		const currentBranch = this.currentGitBranch(ctx.cwd);
		if (currentBranch === targetBranch) return true;

		if (this.localBranchExists(ctx.cwd, targetBranch)) {
			if (!this.switchToBranch(ctx.cwd, targetBranch)) {
				ctx.ui.notify(`Failed to switch to PRD branch '${targetBranch}'.`, "error");
				return false;
			}
			ctx.ui.notify(`Switched to PRD branch '${targetBranch}'.`, "info");
			return true;
		}

		const baseBranch = await this.chooseBranchBase(ctx, targetBranch, currentBranch);
		if (!baseBranch) {
			ctx.ui.notify(`Loop start cancelled: unable to choose a base branch for '${targetBranch}'.`, "warning");
			return false;
		}

		if (!this.createBranchFrom(ctx.cwd, targetBranch, baseBranch)) {
			ctx.ui.notify(`Failed to create branch '${targetBranch}' from '${baseBranch}'.`, "error");
			return false;
		}

		ctx.ui.notify(`Created and switched to '${targetBranch}' from '${baseBranch}'.`, "info");
		return true;
	}

	private readLastBranchName(cwd: string): string | null {
		const file = this.lastBranchFile(cwd);
		if (!fs.existsSync(file)) return null;

		try {
			const value = fs.readFileSync(file, "utf8").trim();
			return value.length > 0 ? value : null;
		} catch {
			return null;
		}
	}

	private writeLastBranchName(cwd: string, branchName: string) {
		const file = this.lastBranchFile(cwd);
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, `${branchName.trim()}\n`, "utf8");
		} catch {
			// best-effort metadata
		}
	}

	private progressHeader(branchName: string | null): string {
		return [
			"## Codebase Patterns",
			"- Add reusable, project-wide implementation patterns here.",
			"---",
			"",
			"## PRD Run Context",
			`PRD Branch: ${branchName ?? "N/A"}`,
			`Started: ${new Date().toISOString()}`,
			"---",
			"",
		].join("\n");
	}

	private archiveSuffixFromBranch(branchName: string): string {
		const stripped = branchName.replace(/^ralph\//, "").trim();
		const safe = stripped.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
		return safe.length > 0 ? safe : "unknown-branch";
	}

	private ensureProgressFileForCurrentPrd(cwd: string): { rotated: boolean; archivePath?: string; branchName?: string } {
		const currentBranch = this.readPrdBranchName(cwd);
		const lastBranch = this.readLastBranchName(cwd);
		const progressPath = this.progressFile(cwd);

		if (!fs.existsSync(progressPath)) {
			try {
				fs.mkdirSync(path.dirname(progressPath), { recursive: true });
				fs.writeFileSync(progressPath, this.progressHeader(currentBranch), "utf8");
			} catch {
				// best-effort file bootstrap
			}
		}

		if (currentBranch && lastBranch && currentBranch !== lastBranch) {
			let archivePath: string | undefined;
			try {
				const stamp = new Date().toISOString().slice(0, 10);
				archivePath = path.join(this.archiveDir(cwd), `${stamp}-${this.archiveSuffixFromBranch(lastBranch)}`);
				fs.mkdirSync(archivePath, { recursive: true });
				if (fs.existsSync(progressPath)) {
					fs.copyFileSync(progressPath, path.join(archivePath, path.basename(PROGRESS_FILE_NAME)));
				}
				const prdPath = this.prdFile(cwd);
				if (fs.existsSync(prdPath)) {
					fs.copyFileSync(prdPath, path.join(archivePath, path.basename(PRD_FILE_NAME)));
				}
			} catch {
				archivePath = undefined;
			}

			try {
				fs.mkdirSync(path.dirname(progressPath), { recursive: true });
				fs.writeFileSync(progressPath, this.progressHeader(currentBranch), "utf8");
			} catch {
				// best-effort reset
			}

			this.writeLastBranchName(cwd, currentBranch);
			return { rotated: true, archivePath, branchName: currentBranch };
		}

		if (currentBranch) this.writeLastBranchName(cwd, currentBranch);
		return { rotated: false, branchName: currentBranch ?? undefined };
	}

	private readConfigYaml(cwd: string): string | null {
		return readLoopConfigYaml(cwd, CONFIG_FILE_PATH);
	}

	private parseConfigYaml(raw: string): LoopConfigData {
		return parseLoopConfigYaml(raw);
	}

	private loadConfigData(cwd: string): LoopConfigData {
		return loadLoopConfigData(cwd, CONFIG_FILE_PATH);
	}

	private hasAdvancedReviewControls(controls: LoopReviewControls): boolean {
		return hasAdvancedReviewControlsFromConfig(controls);
	}

	private hasReflectionConfig(reflection: LoopReflectionConfig): boolean {
		return hasReflectionConfigFromConfig(reflection);
	}

	private reflectionCheckpointInfo(cwd: string, iteration: number): ReflectionCheckpointInfo | null {
		return reflectionCheckpointInfoFromConfig(cwd, iteration, CONFIG_FILE_PATH);
	}

	private reflectionCountdownLabel(info: ReflectionCheckpointInfo): string {
		return reflectionCountdownLabelFromConfig(info);
	}

	private renderReflectionPromptBlock(iteration: number, info: ReflectionCheckpointInfo): string {
		return renderReflectionPromptBlockFromConfig(iteration, info);
	}

	private renderLoopConfigSection(
		guidance: string | null,
		controls: LoopReviewControls,
		reflection: LoopReflectionConfig,
	): string[] {
		return renderLoopConfigSectionFromConfig(guidance, controls, reflection);
	}

	private upsertLoopSection(raw: string, sectionLines: string[] | null): string {
		return upsertLoopConfigSection(raw, sectionLines);
	}

	private readStateFile(cwd: string): PersistedState | null {
		return readPersistedStateFile(cwd, STATE_FILE_PATH);
	}

	private writeStateFile(cwd: string, state: PersistedState) {
		writePersistedStateFile(cwd, STATE_FILE_PATH, state);
	}

	private newerState(a: PersistedState | null, b: PersistedState | null): PersistedState | null {
		return newerPersistedState(a, b);
	}

	private persistState(ctx: RalphiContext) {
		const state = this.snapshotState();
		this.pi.appendEntry(STATE_ENTRY_TYPE, state);
		this.writeStateFile(ctx.cwd, state);
		this.updateLoopStatusLine(ctx);
	}

	private restoreStateFromSession(ctx: RalphiContext) {
		const branchLatest = latestPersistedStateFromBranch(ctx.sessionManager.getBranch(), STATE_ENTRY_TYPE);
		const fileLatest = this.readStateFile(ctx.cwd);
		const latest = this.newerState(branchLatest, fileLatest);

		applyPersistedState(latest, this.phaseRuns, this.loops);
		this.rebuildIndexes();
		this.pruneEphemeralState();
		this.updateLoopStatusLine(ctx);
	}

	private currentPhaseRunForSession(ctx: RalphiContext): PhaseRun | undefined {
		const key = this.sessionKey(ctx);
		return [...this.phaseRuns.values()]
			.filter((run) => run.sessionKey === key && run.status !== "completed")
			.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
			.at(-1);
	}

	private updatePhaseStatusLine(ctx: RalphiContext) {
		const current = this.currentPhaseRunForSession(ctx);
		if (!current) {
			ctx.ui.setStatus("ralphi-phase", undefined);
			return;
		}
		const status = current.status === "awaiting_finalize" ? "awaiting finalize" : "running";
		const elapsed = formatDuration(current.createdAt);
		ctx.ui.setStatus("ralphi-phase", `🧩 ${current.phase} ${current.id} (${status}${elapsed ? ` · ${elapsed}` : ""})`);
	}

	private clearTimingWidget(ctx: RalphiContext) {
		if (!ctx.hasUI) return;
		const ui = ctx.ui as unknown as { setWidget?: (key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) => void };
		if (typeof ui.setWidget !== "function") return;
		ui.setWidget("ralphi-timing", undefined);
	}

	private updateLoopStatusLine(ctx: RalphiContext) {
		const loop = activeLoop(this.loops);
		if (!loop) {
			ctx.ui.setStatus("ralphi-loop", undefined);
		} else {
			const reflectionInfo = this.reflectionCheckpointInfo(ctx.cwd, loop.iteration);
			const reflectionSuffix = reflectionInfo ? ` · ${this.reflectionCountdownLabel(reflectionInfo)}` : "";
			const stoppingSuffix = loop.stopRequested ? " · stopping" : "";
			const elapsed = formatDuration(loop.createdAt);
			const elapsedSuffix = elapsed ? ` · ${elapsed}` : "";
			const iterationElapsed = loop.currentIterationStartedAt ? formatDuration(loop.currentIterationStartedAt) : null;
			const iterationSuffix = iterationElapsed ? ` · iter ${iterationElapsed}` : "";
			ctx.ui.setStatus("ralphi-loop", `🔁 ${loop.id} ${loop.iteration}/${loop.maxIterations}${elapsedSuffix}${iterationSuffix}${reflectionSuffix}${stoppingSuffix}`);
		}
		this.updatePhaseStatusLine(ctx);
		this.clearTimingWidget(ctx);
	}

	private deactivateLoop(loop: LoopRun) {
		if (!loop.completedAt) {
			loop.completedAt = new Date().toISOString();
		}
		loop.active = false;
		loop.activeIterationSessionFile = undefined;
		loop.currentIterationStartedAt = undefined;
	}

	private async finalizeNonLoopRun(run: PhaseRun, ctx: ExtensionCommandContext) {
		await this.phaseController.finalizeNonLoopRun(run, ctx);
	}

	private async finalizeLoopRun(run: PhaseRun, ctx: ExtensionCommandContext) {
		await this.loopFinalizer.finalizeLoopRun(run, ctx);
	}

	async startPhase(ctx: ExtensionCommandContext, phase: NonLoopPhaseName, args: string) {
		await this.phaseController.startPhase(ctx, phase, args);
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
		await this.loopController.runLoopIteration(ctx, loopId);
	}

	async startLoop(ctx: ExtensionCommandContext, args: string) {
		await this.loopController.startLoop(ctx, args);
	}

	async stopLoop(ctx: ExtensionCommandContext, requested: string) {
		await this.loopController.stopLoop(ctx, requested);
	}

	async openLoop(ctx: ExtensionCommandContext, requested: string) {
		await this.loopController.openLoop(ctx, requested);
	}

	async openLoopController(ctx: ExtensionCommandContext, requested: string) {
		await this.loopController.openLoopController(ctx, requested);
	}

	showLoopStatus(ctx: ExtensionCommandContext) {
		this.loopController.showLoopStatus(ctx);
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

	private validateLoopReflectionCheckpointMetadata(run: PhaseRun, params: PhaseDoneInput): { ok: true } | { ok: false; text: string } {
		if (run.phase !== "ralphi-loop-iteration") return { ok: true };

		const reflectionInfo = this.reflectionCheckpointInfo(run.cwd, run.iteration ?? 0);
		if (!reflectionInfo?.isCheckpoint) return { ok: true };

		const missingFields: string[] = [];
		if (!params.reflectionSummary?.trim()) missingFields.push("reflectionSummary");
		if (!params.nextIterationPlan?.trim()) missingFields.push("nextIterationPlan");
		if (missingFields.length === 0) return { ok: true };

		const iterationLabel = Number.isFinite(run.iteration) ? run.iteration : "?";
		return {
			ok: false,
			text:
				`Reflection checkpoint requirements not met for ${run.id} (iteration ${iterationLabel}, loop.reflectEvery=${reflectionInfo.cadence}). ` +
				`Missing required field(s): ${missingFields.join(", ")}. ` +
				"Provide these fields in ralphi_phase_done, then retry. " +
				"Example: { \"reflectionSummary\": \"Key findings + confidence\", \"nextIterationPlan\": \"1) ... 2) ...\" }",
		};
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

		const reflectionValidation = this.validateLoopReflectionCheckpointMetadata(run, params);
		if (!reflectionValidation.ok) {
			return { ok: false, text: reflectionValidation.text };
		}

		run.summary = params.summary;
		run.outputs = params.outputs ?? [];
		run.complete = params.complete ?? false;
		run.reviewPasses = params.reviewPasses ?? 1;
		run.trajectory = params.trajectory;
		run.trajectoryNotes = params.trajectoryNotes?.trim() || undefined;
		run.correctivePlan = params.correctivePlan?.trim() || undefined;
		run.reflectionSummary = params.reflectionSummary?.trim() || undefined;
		run.nextIterationPlan = params.nextIterationPlan?.trim() || undefined;
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
			reflectionSummary: run.reflectionSummary,
			nextIterationPlan: run.nextIterationPlan,
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
					run.completedAt = new Date().toISOString();
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
		const run = this.phaseController.getCurrentlyFinalizingRun();
		if (!run) return undefined;
		if (run.checkpointLeafId !== event.preparation.targetId) return undefined;

		const summary = buildDeterministicSummary(run);
		if (!summary) return undefined;
		return {
			summary: {
				summary,
				details: { phase: run.phase, runId: run.id },
			},
		};
	}

	handleBeforeCompact(): { cancel: boolean } | undefined {
		if (!this.phaseController.consumeSkipNextCompact()) return undefined;
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
			toolHint += `\n\n[LOOP COMPLETION RULE]\nWhen calling ralphi_phase_done for loop iterations:\n- Set complete=false (or omit complete) while selectable PRD stories remain open/in_progress.\n- Set complete=true as soon as no user stories remain unfinished (status != done) in ${PRD_FILE_NAME} (or loop goals are fully done).`;
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
