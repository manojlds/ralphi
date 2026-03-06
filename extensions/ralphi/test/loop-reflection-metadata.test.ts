import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RalphiRuntime } from "../src/runtime";
import { registerTools } from "../src/tools";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager } from "./factories/pi";

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-reflection-metadata-"));
}

function extractRunId(messages: Array<{ text: string }>): string {
	const kickoff = messages.find((m) => m.text.includes("runId:"));
	const match = kickoff?.text.match(/runId:\s*"?([^"\s\n]+)"?/);
	if (!match) throw new Error("runId not found");
	return match[1];
}

describe("loop reflection metadata requirements", () => {
	it("fails checkpoint completion when reflection metadata fields are missing", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reflectEvery: 1",
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
				summary: "checkpoint done",
				complete: false,
				outputs: [],
			});

			expect(done.ok).toBe(false);
			expect(done.text).toContain("Reflection checkpoint requirements not met");
			expect(done.text).toContain("reflectionSummary");
			expect(done.text).toContain("nextIterationPlan");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts checkpoint completion when required reflection metadata is provided", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reflectEvery: 1",
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
				summary: "checkpoint done",
				complete: false,
				outputs: [],
				reflectionSummary: "Aligned with scope, medium confidence.",
				nextIterationPlan: "1) Implement validation 2) Add tests 3) Re-run checks",
			});

			expect(done.ok).toBe(true);
			expect(done.text).toContain("Recorded completion for ralphi-loop-iteration");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not require reflection metadata on non-checkpoint iterations", async () => {
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

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const runId = extractRunId(api.sendUserMessages);

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "iteration 1 done",
				complete: false,
				outputs: [],
			});

			expect(done.ok).toBe(true);
			expect(done.text).toContain("Recorded completion for ralphi-loop-iteration");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps non-loop phases unaffected by checkpoint metadata validation", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reflectEvery: 1",
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startPhase(ctx as any, "ralphi-init", "");
			const runId = extractRunId(api.sendUserMessages);

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-init",
				summary: "init done",
				outputs: [],
			});

			expect(done.ok).toBe(true);
			expect(done.text).toContain("Recorded completion for ralphi-init");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers reflection metadata fields on ralphi_phase_done as additive optional parameters", () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);

		registerTools(api as any, runtime);
		const phaseDoneTool = api.registeredTools.find((tool: any) => tool.name === "ralphi_phase_done") as any;
		expect(phaseDoneTool).toBeDefined();

		const properties = phaseDoneTool.parameters?.properties as Record<string, unknown>;
		expect(properties).toBeDefined();
		expect(properties.reflectionSummary).toBeDefined();
		expect(properties.nextIterationPlan).toBeDefined();
	});
});
