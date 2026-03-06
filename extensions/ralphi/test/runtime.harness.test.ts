import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { registerEvents } from "../src/events";
import { RalphiRuntime } from "../src/runtime";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager, createMockUi } from "./factories/pi";

/** Helper: extract runId from a kickoff message (handles both quoted and unquoted formats) */
function extractRunId(messages: Array<{ text: string }>): string {
	const kickoff = messages.find((m) => m.text.includes("runId:") || m.text.includes("runId"));
	const match = kickoff?.text.match(/runId:\s*"?([^"\s\n]+)"?/);
	if (!match) throw new Error("runId not found in messages");
	return match[1];
}

/** Helper: extract loopId from a kickoff message */
function extractLoopId(messages: Array<{ text: string }>): string {
	const kickoff = messages.find((m) => m.text.includes("loopId:"));
	const match = kickoff?.text.match(/loopId: (loop-[a-f0-9]+)/);
	if (!match) throw new Error("loopId not found in messages");
	return match[1];
}

/** Helper: create a runtime with session_switch events wired up (simulates real Pi) */
function createRuntimeWithEvents(sessionManager: ReturnType<typeof createMockSessionManager>, cwd: string) {
	const api = createMockExtensionApi(sessionManager);
	const runtime = new RalphiRuntime(api as any);
	registerEvents(api as any, runtime);

	const switchHandlers = api.registeredEvents.get("session_switch") ?? [];
	const origSwitchTo = sessionManager.switchTo.bind(sessionManager);
	const ui = createMockUi();
	sessionManager.switchTo = (sessionFile: string) => {
		origSwitchTo(sessionFile);
		for (const handler of switchHandlers) {
			(handler as any)({}, { cwd, hasUI: true, sessionManager, ui, isIdle: () => true });
		}
	};

	return { api, runtime, ui };
}

describe("ralphi extension unit-test harness", () => {
	it("runs runtime phase startup without a real Pi session", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-project-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startPhase(ctx as any, "ralphi-prd", "pi extension unit tests");

			expect(api.sendUserMessages).toHaveLength(1);
			expect(api.sendUserMessages[0].text).toContain("ralphi_phase_done");
			expect(api.sendUserMessages[0].text).toContain("runId");
			expect(api.labels).toHaveLength(1);
			expect(api.labels[0].label).toContain("ralphi:ralphi-prd:checkpoint:run-");
			expect(ctx.ui.notifications.some((n) => n.message.includes("Started ralphi-prd"))).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("startLoop directly runs first iteration without sending /ralphi-loop-next", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-direct-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");

			// Should NOT have sent /ralphi-loop-next as a message
			expect(api.sendUserMessages.some((m) => m.text.startsWith("/ralphi-loop-next"))).toBe(false);
			// Should have sent the iteration kickoff directly
			const kickoff = api.sendUserMessages.find((m) => m.text.includes("runId:"));
			expect(kickoff).toBeDefined();
			expect(kickoff!.text).toContain("ralphi-loop");
			expect(kickoff!.text).toContain("iteration: 1/2");
			// Should have created a child session
			expect(ctx.newSessionCalls).toHaveLength(1);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resets progress.txt and archives prior run data when PRD branch changes", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-progress-rotate-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const prdPath = path.join(tempDir, ".ralphi", "prd.json");
			fs.writeFileSync(
				prdPath,
				JSON.stringify(
					{
						project: "ralphi",
						branchName: "ralph/new-feature",
						userStories: [{ id: "US-001", title: "Story", priority: 1, passes: false }],
					},
					null,
					2,
				),
			);
			fs.writeFileSync(path.join(tempDir, ".ralphi", ".last-branch"), "ralph/old-feature\n", "utf8");
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "progress.txt"),
				[
					"## Codebase Patterns",
					"- old pattern",
					"---",
					"",
					"## 2026-03-06T00:00:00Z - OLD",
					"- old run entry",
					"---",
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 1");

			const updatedProgress = fs.readFileSync(path.join(tempDir, ".ralphi", "progress.txt"), "utf8");
			expect(updatedProgress).toContain("## PRD Run Context");
			expect(updatedProgress).toContain("PRD Branch: ralph/new-feature");
			expect(updatedProgress).not.toContain("old run entry");
			expect(fs.readFileSync(path.join(tempDir, ".ralphi", ".last-branch"), "utf8").trim()).toBe("ralph/new-feature");
			expect(ctx.ui.notifications.some((n) => n.message.includes("Detected new PRD branch"))).toBe(true);

			const archiveRoot = path.join(tempDir, ".ralphi", "archive");
			expect(fs.existsSync(archiveRoot)).toBe(true);
			const archiveFolders = fs.readdirSync(archiveRoot);
			expect(archiveFolders.length).toBe(1);
			const archivedProgress = fs.readFileSync(path.join(archiveRoot, archiveFolders[0], "progress.txt"), "utf8");
			expect(archivedProgress).toContain("old run entry");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not reset progress.txt when PRD branch is unchanged", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-progress-keep-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const prdPath = path.join(tempDir, ".ralphi", "prd.json");
			fs.writeFileSync(
				prdPath,
				JSON.stringify(
					{
						project: "ralphi",
						branchName: "ralph/same-feature",
						userStories: [{ id: "US-001", title: "Story", priority: 1, passes: false }],
					},
					null,
					2,
				),
			);
			fs.writeFileSync(path.join(tempDir, ".ralphi", ".last-branch"), "ralph/same-feature\n", "utf8");
			const existingProgress = [
				"## Codebase Patterns",
				"- keep this",
				"---",
				"",
				"## Existing Run",
				"- keep this entry",
				"---",
				"",
			].join("\n");
			fs.writeFileSync(path.join(tempDir, ".ralphi", "progress.txt"), existingProgress, "utf8");

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 1");

			const updatedProgress = fs.readFileSync(path.join(tempDir, ".ralphi", "progress.txt"), "utf8");
			expect(updatedProgress).toBe(existingProgress);
			expect(ctx.ui.notifications.some((n) => n.message.includes("Detected new PRD branch"))).toBe(false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("auto-completes loop immediately when prd.json has no pending stories", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-no-pending-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "prd.json"),
				JSON.stringify(
					{
						project: "ralphi",
						userStories: [{ id: "US-001", title: "Already done", priority: 1, passes: true }],
					},
					null,
					2,
				),
			);
			fs.writeFileSync(path.join(tempDir, ".ralphi", "progress.txt"), "## Codebase Patterns\n---\n", "utf8");

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");

			expect(ctx.newSessionCalls).toHaveLength(0);
			expect(api.sendUserMessages.some((m) => m.text.includes("runId:"))).toBe(false);
			expect(ctx.ui.notifications.some((n) => n.message.includes("complete after 0 iteration(s)"))).toBe(true);
			const progress = fs.readFileSync(path.join(tempDir, ".ralphi", "progress.txt"), "utf8");
			expect(progress).toContain("Loop Auto-Completion");
			expect(progress).toContain("No pending PRD stories remain");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("auto-completes loop after finalize when no pending stories remain", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-exhausted-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const prdPath = path.join(tempDir, ".ralphi", "prd.json");
			fs.writeFileSync(
				prdPath,
				JSON.stringify(
					{
						project: "ralphi",
						userStories: [{ id: "US-001", title: "Single story", priority: 1, passes: false }],
					},
					null,
					2,
				),
			);
			fs.writeFileSync(path.join(tempDir, ".ralphi", "progress.txt"), "## Codebase Patterns\n---\n", "utf8");

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");
			const runId = extractRunId(api.sendUserMessages);

			const prd = JSON.parse(fs.readFileSync(prdPath, "utf8"));
			prd.userStories[0].passes = true;
			fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));

			await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "completed only story",
				complete: false,
				outputs: [],
			});
			await runtime.finalizeRun(ctx as any, runId);

			expect(ctx.newSessionCalls).toHaveLength(1);
			expect(api.sendUserMessages.filter((m) => m.text.includes("runId:")).length).toBe(1);
			expect(ctx.ui.notifications.some((n) => n.message.includes("complete after 1 iteration(s)"))).toBe(true);
			const progress = fs.readFileSync(path.join(tempDir, ".ralphi", "progress.txt"), "utf8");
			expect(progress).toContain("Loop Auto-Completion");
			expect(progress).toContain("Iteration count at stop: 1");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("auto-completes after checkpoint finalize when reflection cadence is enabled and no pending stories remain", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-reflect-exhausted-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const prdPath = path.join(tempDir, ".ralphi", "prd.json");
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reflectEvery: 1",
					"",
				].join("\n"),
				"utf8",
			);
			fs.writeFileSync(
				prdPath,
				JSON.stringify(
					{
						project: "ralphi",
						userStories: [{ id: "US-001", title: "Single story", priority: 1, passes: false }],
					},
					null,
					2,
				),
			);
			fs.writeFileSync(path.join(tempDir, ".ralphi", "progress.txt"), "## Codebase Patterns\n---\n", "utf8");

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");
			const runId = extractRunId(api.sendUserMessages);

			const prd = JSON.parse(fs.readFileSync(prdPath, "utf8"));
			prd.userStories[0].passes = true;
			fs.writeFileSync(prdPath, JSON.stringify(prd, null, 2));

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "completed only story at checkpoint",
				complete: false,
				outputs: [],
				reflectionSummary: "Story completed and no remaining open PRD stories.",
				nextIterationPlan: "Stop loop because no stories remain.",
			});
			expect(done.ok).toBe(true);

			await runtime.finalizeRun(ctx as any, runId);

			expect(ctx.newSessionCalls).toHaveLength(1);
			expect(api.sendUserMessages.filter((m) => m.text.includes("runId:")).length).toBe(1);
			expect(ctx.ui.notifications.some((n) => n.message.includes("complete after 1 iteration(s)"))).toBe(true);
			const progress = fs.readFileSync(path.join(tempDir, ".ralphi", "progress.txt"), "utf8");
			expect(progress).toContain("Loop Auto-Completion");
			expect(progress).toContain("Iteration count at stop: 1");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("continues loop unless ralphi_phase_done sets complete=true", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-project-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 3");
			const runId = extractRunId(api.sendUserMessages);

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "completed first story",
				complete: false,
				outputs: [],
			});
			expect(done.ok).toBe(true);

			await runtime.finalizeRun(ctx as any, runId);

			// Should have started a second iteration (not sent /ralphi-loop-next)
			expect(api.sendUserMessages.some((m) => m.text.startsWith("/ralphi-loop-next"))).toBe(false);
			const secondKickoff = api.sendUserMessages[api.sendUserMessages.length - 1].text;
			expect(secondKickoff).toContain("iteration: 2/3");
			expect(secondKickoff).toContain("runId:");
			// Two child sessions total (iter 1 + iter 2)
			expect(ctx.newSessionCalls).toHaveLength(2);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stops loop when ralphi_phase_done sets complete=true", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-complete-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");
			const runId = extractRunId(api.sendUserMessages);

			await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "all stories done",
				complete: true,
				outputs: [],
			});
			await runtime.finalizeRun(ctx as any, runId);

			// Should NOT have started another iteration
			expect(ctx.newSessionCalls).toHaveLength(1);
			expect(ctx.ui.notifications.some((n) => n.message.includes("complete after 1 iteration(s)"))).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stops loop when max iterations reached", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-max-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 1");
			const runId = extractRunId(api.sendUserMessages);

			await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "done",
				complete: false,
				outputs: [],
			});
			await runtime.finalizeRun(ctx as any, runId);

			// Should NOT have started another iteration — max reached
			expect(ctx.newSessionCalls).toHaveLength(1);
			expect(ctx.ui.notifications.some((n) => n.message.includes("max iterations (1)"))).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("stops loop when stop is requested", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-stop-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");
			const runId = extractRunId(api.sendUserMessages);
			const loopId = extractLoopId(api.sendUserMessages);

			// Request stop while iteration is running
			await runtime.stopLoop(ctx as any, loopId);

			await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "done",
				complete: false,
				outputs: [],
			});
			await runtime.finalizeRun(ctx as any, runId);

			// Should NOT have started another iteration — stop requested
			expect(ctx.newSessionCalls).toHaveLength(1);
			expect(ctx.ui.notifications.some((n) => n.message.includes("stopped by user"))).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts loopId alias when marking loop iteration done", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-alias-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const actualRunId = extractRunId(api.sendUserMessages);
			const loopId = extractLoopId(api.sendUserMessages);

			// Use loopId instead of runId — should resolve via alias
			const done = await runtime.markPhaseDone(ctx as any, {
				runId: loopId,
				phase: "ralphi-loop-iteration",
				summary: "done via loop alias",
				complete: false,
				outputs: [],
			});
			expect(done.ok).toBe(true);
			expect(done.text).toContain("Recorded completion for ralphi-loop-iteration");

			await runtime.finalizeRun(ctx as any, actualRunId);
			// Next iteration should have started
			const lastMsg = api.sendUserMessages[api.sendUserMessages.length - 1].text;
			expect(lastMsg).toContain("iteration: 2/2");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("auto-finalizes queued runs on turn_end instead of sending /ralphi-finalize as plain text", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-project-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

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
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("names loop iteration sessions using the next pending story from prd.json", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const prdPath = path.join(tempDir, ".ralphi", "prd.json");
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

			expect(api.sessionNames.at(-1)).toContain("US-002 Highest priority story");
			// Story suggestion is NOT in kickoff — the skill handles story selection
			expect(api.sendUserMessages.at(-1)?.text).toContain("ralphi-loop");
			expect(api.sendUserMessages.at(-1)?.text).not.toContain("Suggested next story");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("supports interactive loop selection in /ralphi-loop-open", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-open-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ui = createMockUi();
			ui.select = async (title, options) => {
				ui.selectCalls.push({ title, options });
				return options.find((option) => option.startsWith("loop-old"));
			};
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir, ui });

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
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("session_switch during finalize does not clobber loop state", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-clobber-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const { api, runtime } = createRuntimeWithEvents(sessionManager, tempDir);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 3");
			const runId = extractRunId(api.sendUserMessages);

			await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "Completed story US-001",
				complete: false,
				outputs: [],
			});

			await runtime.finalizeRun(ctx as any, runId);

			// Verify iteration count is correct (should be iter 2, not reset to 0)
			const lastKickoff = api.sendUserMessages[api.sendUserMessages.length - 1].text;
			expect(lastKickoff).toContain("iteration: 2/3");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("session_switch during finalize preserves complete=true termination", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-complete-event-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const { api, runtime } = createRuntimeWithEvents(sessionManager, tempDir);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");
			const runId = extractRunId(api.sendUserMessages);

			await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-loop-iteration",
				summary: "all stories done",
				complete: true,
				outputs: [],
			});

			await runtime.finalizeRun(ctx as any, runId);

			// Should NOT have started a second iteration
			expect(ctx.newSessionCalls).toHaveLength(1);
			// Should say "1 iteration(s)", not "0 iteration(s)"
			expect(ctx.ui.notifications.some((n) => n.message.includes("complete after 1 iteration(s)"))).toBe(true);
			expect(ctx.ui.notifications.some((n) => n.message.includes("0 iteration(s)"))).toBe(false);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("multi-iteration loop runs correctly with session_switch events", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-multi-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const { api, runtime } = createRuntimeWithEvents(sessionManager, tempDir);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");

			// Run 3 iterations
			for (let i = 1; i <= 3; i++) {
				const runId = extractRunId(
					api.sendUserMessages.filter((m) => m.text.includes(`iteration: ${i}/5`)),
				);

				await runtime.markPhaseDone(ctx as any, {
					runId,
					phase: "ralphi-loop-iteration",
					summary: `completed iteration ${i}`,
					complete: i === 3,
					outputs: [],
				});

				await runtime.finalizeRun(ctx as any, runId);
			}

			// Should have created exactly 3 child sessions
			expect(ctx.newSessionCalls).toHaveLength(3);
			// Loop should be complete
			expect(ctx.ui.notifications.some((n) => n.message.includes("complete after 3 iteration(s)"))).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("restores loop state across sessions via project state file", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-state-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionA = createMockSessionManager("controller-a.json");
			const apiA = createMockExtensionApi(sessionA);
			const runtimeA = new RalphiRuntime(apiA as any);
			const ctxA = createMockCommandContext({ sessionManager: sessionA, cwd: tempDir });

			await runtimeA.startLoop(ctxA as any, "--max-iterations 3");
			const loopId = extractLoopId(apiA.sendUserMessages);

			const sessionB = createMockSessionManager("controller-b.json");
			const apiB = createMockExtensionApi(sessionB);
			const runtimeB = new RalphiRuntime(apiB as any);
			const ctxB = createMockCommandContext({ sessionManager: sessionB, cwd: tempDir });

			await runtimeB.openLoop(ctxB as any, loopId);

			expect(ctxB.switchCalls.length).toBeGreaterThan(0);
			expect(ctxB.switchCalls[0]).toMatch(/^session-\d+\.json$/);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prevents starting a second loop while one is active", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-double-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			await runtime.startLoop(ctx as any, "--max-iterations 2");

			expect(ctx.ui.notifications.some((n) => n.message.includes("Loop already active"))).toBe(true);
			// Only one child session created (from the first loop)
			expect(ctx.newSessionCalls).toHaveLength(1);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("phase mismatch is rejected by markPhaseDone", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-mismatch-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startPhase(ctx as any, "ralphi-init", "");
			const runId = extractRunId(api.sendUserMessages);

			const done = await runtime.markPhaseDone(ctx as any, {
				runId,
				phase: "ralphi-prd",
				summary: "wrong phase",
				outputs: [],
			});

			expect(done.ok).toBe(false);
			expect(done.text).toContain("Phase mismatch");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects markPhaseDone for unknown runId", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-unknown-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			const done = await runtime.markPhaseDone(ctx as any, {
				runId: "nonexistent-run",
				phase: "ralphi-init",
				summary: "should fail",
				outputs: [],
			});

			expect(done.ok).toBe(false);
			expect(done.text).toContain("Run not found");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("state file reflects correct iteration after startLoop", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-state-file-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 5");

			const stateFile = path.join(tempDir, ".ralphi", "runtime-state.json");
			expect(fs.existsSync(stateFile)).toBe(true);
			const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

			expect(state.loops).toHaveLength(1);
			expect(state.loops[0].iteration).toBe(1);
			expect(state.loops[0].active).toBe(true);
			expect(state.loops[0].iterationSessionFiles).toHaveLength(1);
			expect(state.phaseRuns).toHaveLength(1);
			expect(state.phaseRuns[0].phase).toBe("ralphi-loop-iteration");
			expect(state.phaseRuns[0].status).toBe("running");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

// ---- isIdle() pre-flight checks ----

describe("isIdle pre-flight guard", () => {
	it("startPhase refuses when agent is busy", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-idle-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir, idle: false });

			await runtime.startPhase(ctx as any, "ralphi-init", "");

			// No kickoff message should be sent
			expect(api.sendUserMessages).toHaveLength(0);
			// Error notification should fire
			expect(ctx.ui.notifications.some(
				(n: { message: string; level: string }) => n.level === "error" && n.message.includes("busy"),
			)).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("startPhase proceeds when agent is idle", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-idle-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir, idle: true });

			await runtime.startPhase(ctx as any, "ralphi-init", "");

			// Kickoff message should be sent
			expect(api.sendUserMessages.length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("startLoop refuses when agent is busy", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-idle-"));
		fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir, idle: false });

			// Create a minimal prd.json so startLoop doesn't fail for other reasons
			const ralphiDir = path.join(tempDir, ".ralphi");
			fs.mkdirSync(ralphiDir, { recursive: true });
			fs.writeFileSync(path.join(ralphiDir, "prd.json"), JSON.stringify({
				feature: "test",
				branch: "test-branch",
				stories: [{ id: "S1", title: "Story 1", description: "desc", priority: 1, acceptanceCriteria: [] }],
			}));

			await runtime.startLoop(ctx as any, "");

			// No loop should be created
			expect(ctx.ui.notifications.some(
				(n: { message: string; level: string }) => n.level === "error" && n.message.includes("busy"),
			)).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
