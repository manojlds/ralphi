import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RalphiRuntime } from "../src/runtime";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager } from "./factories/pi";

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-reflection-checkpoints-"));
}

function extractRunId(messages: Array<{ text: string }>): string {
	const kickoff = messages.find((m) => m.text.includes("runId:"));
	const match = kickoff?.text.match(/runId:\s*([^\s\n]+)/);
	if (!match) throw new Error("runId not found");
	return match[1];
}

describe("loop reflection checkpoints", () => {
	it("injects reflection checkpoint prompt only on cadence iterations", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reflectEvery: 2",
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 3");

			const firstPrompt = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);
			expect(firstPrompt).toBeDefined();
			expect(firstPrompt!.systemPrompt).not.toContain("[REFLECTION CHECKPOINT]");

			const firstRunId = extractRunId(api.sendUserMessages);
			await runtime.markPhaseDone(ctx as any, {
				runId: firstRunId,
				phase: "ralphi-loop-iteration",
				summary: "iteration 1 done",
				complete: false,
				outputs: [],
			});
			await runtime.finalizeRun(ctx as any, firstRunId);

			const secondPrompt = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);
			expect(secondPrompt).toBeDefined();
			expect(secondPrompt!.systemPrompt).toContain("[REFLECTION CHECKPOINT]");
			expect(secondPrompt!.systemPrompt).toContain("Checkpoint questions (answer explicitly):");
			expect(secondPrompt!.systemPrompt).toContain("Required outputs before calling ralphi_phase_done:");
			expect(secondPrompt!.systemPrompt).toContain("(default template)");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses custom loop.reflectInstructions during checkpoint prompt injection", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reflectEvery: 2",
					'  reflectInstructions: "Reassess drift risk, dependencies, and confidence before coding."',
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 3");
			const firstRunId = extractRunId(api.sendUserMessages);

			await runtime.markPhaseDone(ctx as any, {
				runId: firstRunId,
				phase: "ralphi-loop-iteration",
				summary: "iteration 1 done",
				complete: false,
				outputs: [],
			});
			await runtime.finalizeRun(ctx as any, firstRunId);

			const secondKickoff = api.sendUserMessages.at(-1)?.text ?? "";
			expect(secondKickoff).toContain("[REFLECTION CHECKPOINT]");
			expect(secondKickoff).toContain("Project reflection instructions (loop.reflectInstructions):");
			expect(secondKickoff).toContain("Reassess drift risk, dependencies, and confidence before coding.");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("includes reflection countdown in loop status when cadence is enabled", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reflectEvery: 3",
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");
			expect(ctx.ui.statuses.some((entry) => entry.key === "ralphi-loop" && (entry.text ?? "").includes("next reflection in 2 iterations"))).toBe(true);

			runtime.showLoopStatus(ctx as any);
			expect(ctx.ui.notifications.at(-1)?.message).toContain("next reflection in 2 iterations");

			const firstRunId = extractRunId(api.sendUserMessages);
			await runtime.markPhaseDone(ctx as any, {
				runId: firstRunId,
				phase: "ralphi-loop-iteration",
				summary: "iteration 1 done",
				complete: false,
				outputs: [],
			});
			await runtime.finalizeRun(ctx as any, firstRunId);

			runtime.showLoopStatus(ctx as any);
			expect(ctx.ui.notifications.at(-1)?.message).toContain("next reflection in 1 iteration");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
