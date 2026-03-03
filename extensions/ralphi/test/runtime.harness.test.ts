import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RalphiRuntime } from "../src/runtime";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager, createMockUi } from "./factories/pi";

describe("ralphi extension unit-test harness", () => {
	it("runs runtime phase startup without a real Pi session", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		const ctx = createMockCommandContext({ sessionManager, cwd: "/tmp/ralphi-project" });

		await runtime.startPhase(ctx as any, "ralphi-prd", "pi extension unit tests");

		expect(api.sendUserMessages).toHaveLength(1);
		expect(api.sendUserMessages[0].text).toContain("ralphi_phase_done");
		expect(api.sendUserMessages[0].text).toContain("runId");
		expect(api.labels).toHaveLength(1);
		expect(api.labels[0].label).toContain("ralphi:ralphi-prd:checkpoint:run-");
		expect(ctx.ui.notifications.some((n) => n.message.includes("Started ralphi-prd"))).toBe(true);
	});

	it("continues loop unless ralphi_phase_done sets complete=true", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		const ctx = createMockCommandContext({ sessionManager, cwd: "/tmp/ralphi-project" });

		await runtime.startLoop(ctx as any, "--max-iterations 2");
		const loopMessage = api.sendUserMessages.find((m) => m.text.startsWith("/ralphi-loop-next "));
		expect(loopMessage).toBeDefined();
		const loopId = loopMessage!.text.replace("/ralphi-loop-next ", "").trim();

		await runtime.runLoopIteration(ctx as any, loopId);
		const kickoff = api.sendUserMessages[api.sendUserMessages.length - 1].text;
		const runIdMatch = kickoff.match(/runId: "([^"]+)"/);
		expect(runIdMatch).toBeTruthy();
		const runId = runIdMatch![1];

		const done = await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-loop-iteration",
			summary: "all done <promise>COMPLETE</promise>",
			complete: false,
			outputs: [],
		});
		expect(done.ok).toBe(true);

		await runtime.finalizeRun(ctx as any, runId);
		expect(api.sendUserMessages[api.sendUserMessages.length - 1].text).toBe(`/ralphi-loop-next ${loopId}`);
	});

	it("auto-finalizes queued runs on turn_end instead of sending /ralphi-finalize as plain text", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		const ctx = createMockCommandContext({ sessionManager, cwd: "/tmp/ralphi-project" });

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const kickoff = api.sendUserMessages[0].text;
		const runIdMatch = kickoff.match(/runId: "([^"]+)"/);
		expect(runIdMatch).toBeTruthy();
		const runId = runIdMatch![1];

		const done = await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "init complete",
			outputs: [".ralphi/config.yaml"],
		});
		expect(done.ok).toBe(true);
		expect(done.text).toContain("Finalize queued");
		expect(api.sendUserMessages.some((m) => m.text.startsWith("/ralphi-finalize"))).toBe(false);

		await runtime.handleTurnEnd(ctx as any);
		expect(ctx.navigateCalls.length).toBeGreaterThan(0);
	});

	it("names loop iteration sessions using the next pending story from prd.json", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-"));
		try {
			const prdPath = path.join(tempDir, "prd.json");
			fs.writeFileSync(
				prdPath,
				JSON.stringify(
					{
						project: "ralphi",
						branchName: "ralph/story-titles",
						description: "test",
						userStories: [
							{ id: "US-001", title: "Lower priority story", priority: 2, passes: false },
							{ id: "US-002", title: "Highest priority story", priority: 1, passes: false },
						],
					},
					null,
					2,
				),
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const loopId = api.sendUserMessages
				.find((m) => m.text.startsWith("/ralphi-loop-next "))!
				.text.replace("/ralphi-loop-next ", "")
				.trim();

			await runtime.runLoopIteration(ctx as any, loopId);

			expect(api.sessionNames.at(-1)).toContain("US-002 Highest priority story");
			expect(api.sendUserMessages.at(-1)?.text).toContain("Suggested next story from prd.json: US-002 - Highest priority story");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("supports interactive loop selection in /ralphi-loop-open", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		const ui = createMockUi();
		ui.select = async (title, options) => {
			ui.selectCalls.push({ title, options });
			return options.find((option) => option.startsWith("loop-old"));
		};
		const ctx = createMockCommandContext({ sessionManager, cwd: "/tmp/ralphi-project", ui });

		sessionManager.appendCustom("ralphi-state", {
			phaseRuns: [],
			loops: [
				{
					id: "loop-old",
					controllerSessionFile: "controller-old.json",
					maxIterations: 5,
					iteration: 3,
					active: false,
					stopRequested: false,
					createdAt: "2025-01-01T00:00:00.000Z",
					iterationSessionFiles: ["iter-old-1.json", "iter-old-2.json"],
				},
				{
					id: "loop-new",
					controllerSessionFile: "controller-new.json",
					maxIterations: 5,
					iteration: 1,
					active: true,
					stopRequested: false,
					createdAt: "2025-02-01T00:00:00.000Z",
					activeIterationSessionFile: "iter-new-1.json",
					iterationSessionFiles: ["iter-new-1.json"],
				},
			],
			savedAt: new Date().toISOString(),
		});

		await runtime.openLoop(ctx as any, "");

		expect(ui.selectCalls).toHaveLength(1);
		expect(ui.selectCalls[0].title).toBe("Select loop to inspect");
		expect(ctx.switchCalls).toContain("iter-old-2.json");
		expect(ui.notifications.some((entry) => entry.message.includes("most recent iteration session for inactive loop loop-old"))).toBe(true);
	});
});
