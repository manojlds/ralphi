import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { renderOutputs } from "./helpers";
import { formatDuration } from "./time";
import type { NonLoopPhaseName, PhaseRun } from "./types";

// Signal to other extensions that a ralphi tree collapse is in progress.
declare global {
	var __ralphiCollapseInProgress: boolean | undefined;
}

export type PhaseControllerDeps = {
	phaseRuns: Map<string, PhaseRun>;
	activePhaseBySession: Map<string, string>;
	commandContextByRun: Map<string, ExtensionCommandContext>;
	restoreStateFromSession: (ctx: ExtensionCommandContext) => void;
	sessionKey: (ctx: ExtensionCommandContext) => string;
	shortId: (prefix: string) => string;
	sendUserMessage: (ctx: ExtensionCommandContext, text: string, deliveryWhenBusy?: "steer" | "followUp") => void;
	appendRalphiEvent: (kind: string, data: Record<string, unknown>) => void;
	persistState: (ctx: ExtensionCommandContext) => void;
	setLabel: (targetId: string, label: string) => void;
	appendEntry: (customType: string, data: Record<string, unknown>) => void;
	setSuppressEventRestore: (value: boolean) => void;
	checkpointEntryType: string;
};

export class PhaseController {
	private currentlyFinalizingRun: PhaseRun | null = null;
	private skipNextCompact = false;

	constructor(private readonly deps: PhaseControllerDeps) {}

	private findCheckpointEntryId(ctx: ExtensionCommandContext, runId: string): string | null {
		const sources = [ctx.sessionManager.getEntries(), ctx.sessionManager.getBranch()];
		for (const entries of sources) {
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as any;
				if (entry?.type !== "custom") continue;
				if (entry?.customType !== this.deps.checkpointEntryType) continue;
				if (entry?.data?.runId !== runId) continue;
				if (typeof entry?.id === "string" && entry.id.length > 0) return entry.id;
			}
		}
		return null;
	}

	private ensureCheckpointLeafId(ctx: ExtensionCommandContext, runId: string, phase: NonLoopPhaseName): string | null {
		const existingLeaf = ctx.sessionManager.getLeafId();
		if (existingLeaf) return existingLeaf;

		this.deps.appendEntry(this.deps.checkpointEntryType, {
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

	private async withSuppressedEventRestore<T>(run: () => Promise<T>): Promise<T> {
		this.deps.setSuppressEventRestore(true);
		try {
			return await run();
		} finally {
			this.deps.setSuppressEventRestore(false);
		}
	}

	getCurrentlyFinalizingRun(): PhaseRun | null {
		return this.currentlyFinalizingRun;
	}

	consumeSkipNextCompact(): boolean {
		if (!this.skipNextCompact) return false;
		this.skipNextCompact = false;
		return true;
	}

	async finalizeNonLoopRun(run: PhaseRun, ctx: ExtensionCommandContext) {
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
			this.deps.appendRalphiEvent("phase_finalize_cancelled", { runId: run.id, phase: run.phase });
			this.deps.persistState(ctx);
			ctx.ui.notify(`Finalize cancelled for ${run.id}. Run /ralphi-finalize ${run.id} again when ready.`, "info");
			return;
		}

		if (run.checkpointSessionFile && ctx.sessionManager.getSessionFile() !== run.checkpointSessionFile) {
			const switched = await this.withSuppressedEventRestore(async () => {
				return await ctx.switchSession(run.checkpointSessionFile!);
			});
			if (switched.cancelled) {
				ctx.ui.notify("Could not switch back to checkpoint session.", "error");
				return;
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
		run.completedAt = new Date().toISOString();
		const duration = formatDuration(run.createdAt, run.completedAt);
		this.deps.appendRalphiEvent("phase_finalized", {
			runId: run.id,
			phase: run.phase,
			summary: run.summary,
			outputs: run.outputs,
			missingOutputs: outputs.hasMissing,
			duration,
		});
		this.deps.persistState(ctx);
		ctx.ui.notify(
			`Finalized ${run.phase} (${run.id})${duration ? ` in ${duration}` : ""}${outputs.hasMissing ? " — some declared outputs are missing" : ""}`,
			outputs.hasMissing ? "warning" : "info",
		);
	}

	async startPhase(ctx: ExtensionCommandContext, phase: NonLoopPhaseName, args: string) {
		this.deps.restoreStateFromSession(ctx);

		if (!ctx.isIdle()) {
			ctx.ui.notify("Agent is busy — wait for it to finish before starting a ralphi phase.", "error");
			return;
		}

		const key = this.deps.sessionKey(ctx);
		const activeRunId = this.deps.activePhaseBySession.get(key);
		if (activeRunId) {
			ctx.ui.notify(`Another ralphi phase is already active in this session (${activeRunId}).`, "warning");
			return;
		}

		const runId = this.deps.shortId("run");
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

		this.deps.phaseRuns.set(runId, run);
		this.deps.commandContextByRun.set(runId, ctx);
		this.deps.activePhaseBySession.set(key, runId);

		if (checkpointLeafId) {
			this.deps.setLabel(checkpointLeafId, `ralphi:${phase}:checkpoint:${runId}`);
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

		this.deps.appendRalphiEvent("phase_started", { runId, phase, args: args.trim() || undefined });
		this.deps.persistState(ctx);
		ctx.ui.notify(`Started ${phase} (${runId})`, "info");
		this.deps.sendUserMessage(ctx, kickoff, "steer");
	}
}
