import { describe, expect, it } from "vitest";
import { RalphiRuntime } from "../src/runtime";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager } from "./factories/pi";

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
});
