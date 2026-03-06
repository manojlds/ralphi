import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RalphiRuntime } from "../src/runtime";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager } from "./factories/pi";

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-review-controls-"));
}

function extractRunId(messages: Array<{ text: string }>): string {
	const kickoff = messages.find((m) => m.text.includes("runId:"));
	const match = kickoff?.text.match(/runId:\s*([^\s\n]+)/);
	if (!match) throw new Error("runId not found");
	return match[1];
}

describe("optional advanced loop review controls", () => {
	it("keeps default loop completion path backward compatible when controls are not configured", async () => {
		const tempDir = createTempDir();
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const runId = extractRunId(api.sendUserMessages);

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "completed story",
				complete: false,
				outputs: [],
			});

			expect(done.ok).toBe(true);
			expect(done.text).toContain("Recorded completion");
			expect(done.text).not.toContain("Review-pass gate not met");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("enforces opt-in reviewPasses gate from .ralphi/config.yaml loop section", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reviewPasses: 2",
					'  trajectoryGuard: "warn_on_drift"',
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const runId = extractRunId(api.sendUserMessages);

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "completed story",
				reviewPasses: 1,
				complete: false,
				outputs: [],
			});

			expect(done.ok).toBe(false);
			expect(done.text).toContain("required reviewPasses=2");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("requires correctivePlan for DRIFT when trajectoryGuard=require_corrective_plan", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reviewPasses: 2",
					'  trajectoryGuard: "require_corrective_plan"',
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const runId = extractRunId(api.sendUserMessages);

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "completed story",
				reviewPasses: 2,
				trajectory: "DRIFT",
				complete: false,
				outputs: [],
			});

			expect(done.ok).toBe(false);
			expect(done.text).toContain("correctivePlan is missing");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("adds DRIFT corrective-plan signal and next-step guidance to loop output", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reviewPasses: 2",
					'  trajectoryGuard: "require_corrective_plan"',
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const runId = extractRunId(api.sendUserMessages);

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "completed story",
				reviewPasses: 2,
				trajectory: "DRIFT",
				correctivePlan: "Split scope and finish parser first.",
				complete: false,
				outputs: [],
			});
			expect(done.ok).toBe(true);
			expect(done.text).toContain("Trajectory DRIFT signaled");
			expect(done.text).toContain("Next-step guidance");

			await runtime.finalizeRun(ctx as any, runId);
			expect(api.sentMessages.some((entry) => String(entry.message.content).includes("trajectory DRIFT signaled"))).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("injects advanced review control hints into loop iteration prompt only when configured", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reviewPasses: 2",
					'  trajectoryGuard: "warn_on_drift"',
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const injected = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);

			expect(injected).toBeDefined();
			expect(injected!.systemPrompt).toContain("[ADVANCED REVIEW CONTROLS]");
			expect(injected!.systemPrompt).toContain("reviewPasses: 2");
			expect(injected!.systemPrompt).toContain("trajectoryGuard: warn_on_drift");
			expect(injected!.systemPrompt).toContain(".ralphi/config.yaml");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("adds explicit loop completion guidance for complete=true when no pending stories remain", async () => {
		const tempDir = createTempDir();
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const injected = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);

			expect(injected).toBeDefined();
			expect(injected!.systemPrompt).toContain("[LOOP COMPLETION RULE]");
			expect(injected!.systemPrompt).toContain("Set complete=true");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
