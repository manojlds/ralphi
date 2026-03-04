import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RalphiRuntime } from "../src/runtime";
import { ASK_TOOL_PHASES } from "../src/types";
import {
	createMockCommandContext,
	createMockExtensionApi,
	createMockSessionManager,
	createMockUi,
} from "./factories/pi";

function extractRunId(kickoffText: string): string {
	const match = kickoffText.match(/runId: "([^"]+)"/);
	if (!match) throw new Error("Could not extract runId from kickoff text");
	return match[1];
}

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-phase-scoped-"));
}

describe("US-002: Phase-Scoped Availability (Init + PRD)", () => {
	describe("ASK_TOOL_PHASES constant", () => {
		it("includes ralphi-init and ralphi-prd only", () => {
			expect(ASK_TOOL_PHASES).toContain("ralphi-init");
			expect(ASK_TOOL_PHASES).toContain("ralphi-prd");
			expect(ASK_TOOL_PHASES).not.toContain("ralphi-convert");
			expect(ASK_TOOL_PHASES).not.toContain("ralphi-loop-iteration");
			expect(ASK_TOOL_PHASES).toHaveLength(2);
		});
	});

	describe("getActivePhaseForSession", () => {
		it("returns the active phase when a phase is running", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-init", "");

				const phase = runtime.getActivePhaseForSession(ctx as any);
				expect(phase).toBe("ralphi-init");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("returns ralphi-prd when prd phase is running", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-prd", "my-feature a great feature");

				const phase = runtime.getActivePhaseForSession(ctx as any);
				expect(phase).toBe("ralphi-prd");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("returns undefined when no phase is active", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				const phase = runtime.getActivePhaseForSession(ctx as any);
				expect(phase).toBeUndefined();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("returns undefined after phase completes", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-init", "");
				const runId = extractRunId(api.sendUserMessages[0].text);

				await runtime.markPhaseDone(ctx as any, {
					runId,
					phase: "ralphi-init",
					summary: "done",
					outputs: [],
				});

				const phase = runtime.getActivePhaseForSession(ctx as any);
				expect(phase).toBeUndefined();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("ask tool phase enforcement via registerTools", () => {
		it("rejects ralphi_ask_user_question when called during ralphi-convert", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);

				const { registerTools } = await import("../src/tools");
				registerTools(api as any, runtime);

				const askTool = api.registeredTools.find((t: any) => t.name === "ralphi_ask_user_question") as any;
				expect(askTool).toBeDefined();

				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });
				await runtime.startPhase(ctx as any, "ralphi-convert", "my-prd.md");

				const result = await askTool.execute(
					"call-1",
					{ questions: [{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] }] },
					new AbortController().signal,
					() => {},
					ctx as any,
				);

				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain("only available during ralphi-init and ralphi-prd");
				expect(result.content[0].text).toContain("current phase: ralphi-convert");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("rejects ralphi_ask_user_question when no phase is active", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);

				const { registerTools } = await import("../src/tools");
				registerTools(api as any, runtime);

				const askTool = api.registeredTools.find((t: any) => t.name === "ralphi_ask_user_question") as any;
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				const result = await askTool.execute(
					"call-1",
					{ questions: [{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] }] },
					new AbortController().signal,
					() => {},
					ctx as any,
				);

				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain("only available during ralphi-init and ralphi-prd");
				expect(result.content[0].text).toContain("no active ralphi phase");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("allows ralphi_ask_user_question during ralphi-init", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);

				const { registerTools } = await import("../src/tools");
				registerTools(api as any, runtime);

				const askTool = api.registeredTools.find((t: any) => t.name === "ralphi_ask_user_question") as any;

				const ui = createMockUi([], [], ["Web app"]);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir, ui });
				await runtime.startPhase(ctx as any, "ralphi-init", "");

				const result = await askTool.execute(
					"call-1",
					{ questions: [{ id: "project_type", prompt: "Project type?", type: "single", options: ["Web app", "CLI"] }] },
					new AbortController().signal,
					() => {},
					ctx as any,
				);

				expect(result.isError).toBe(false);
				expect(result.details.answers.project_type.selected).toEqual(["Web app"]);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("allows ralphi_ask_user_question during ralphi-prd", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);

				const { registerTools } = await import("../src/tools");
				registerTools(api as any, runtime);

				const askTool = api.registeredTools.find((t: any) => t.name === "ralphi_ask_user_question") as any;

				const ui = createMockUi([], [], ["TypeScript"]);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir, ui });
				await runtime.startPhase(ctx as any, "ralphi-prd", "my-feature a great feature");

				const result = await askTool.execute(
					"call-1",
					{ questions: [{ id: "lang", prompt: "Language?", type: "single", options: ["TypeScript", "Python"] }] },
					new AbortController().signal,
					() => {},
					ctx as any,
				);

				expect(result.isError).toBe(false);
				expect(result.details.answers.lang.selected).toEqual(["TypeScript"]);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("rejects ralphi_ask_user_question during ralphi-loop-iteration", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);

				const { registerTools } = await import("../src/tools");
				registerTools(api as any, runtime);

				const askTool = api.registeredTools.find((t: any) => t.name === "ralphi_ask_user_question") as any;

				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });
				await runtime.startLoop(ctx as any, "--max-iterations 3");

				const result = await askTool.execute(
					"call-1",
					{ questions: [{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] }] },
					new AbortController().signal,
					() => {},
					ctx as any,
				);

				expect(result.isError).toBe(true);
				expect(result.content[0].text).toContain("only available during ralphi-init and ralphi-prd");
				expect(result.content[0].text).toContain("current phase: ralphi-loop-iteration");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("system prompt guidance in handleBeforeAgentStart", () => {
		it("includes ask tool guidance for ralphi-init phase", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-init", "");

				const event = { systemPrompt: "You are a helpful assistant." } as any;
				const result = runtime.handleBeforeAgentStart(event, ctx as any);

				expect(result).toBeDefined();
				expect(result!.systemPrompt).toContain("ralphi_ask_user_question tool is available in this phase");
				expect(result!.systemPrompt).toContain("structured questions");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("includes ask tool guidance for ralphi-prd phase", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-prd", "my-feature a great feature");

				const event = { systemPrompt: "You are a helpful assistant." } as any;
				const result = runtime.handleBeforeAgentStart(event, ctx as any);

				expect(result).toBeDefined();
				expect(result!.systemPrompt).toContain("ralphi_ask_user_question tool is available in this phase");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("does NOT include ask tool guidance for ralphi-convert phase", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-convert", "my-prd.md");

				const event = { systemPrompt: "You are a helpful assistant." } as any;
				const result = runtime.handleBeforeAgentStart(event, ctx as any);

				expect(result).toBeDefined();
				expect(result!.systemPrompt).not.toContain("ralphi_ask_user_question");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("does NOT include ask tool guidance for ralphi-loop-iteration phase", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startLoop(ctx as any, "--max-iterations 3");

				const event = { systemPrompt: "You are a helpful assistant." } as any;
				const result = runtime.handleBeforeAgentStart(event, ctx as any);

				expect(result).toBeDefined();
				expect(result!.systemPrompt).not.toContain("ralphi_ask_user_question");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("returns nothing when no phase is active", () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				const event = { systemPrompt: "You are a helpful assistant." } as any;
				const result = runtime.handleBeforeAgentStart(event, ctx as any);

				expect(result).toBeUndefined();
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("convert and loop behavior unchanged", () => {
		it("ralphi-convert phase still starts and completes normally", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-convert", "my-prd.md");

				expect(api.sendUserMessages).toHaveLength(1);
				expect(api.sendUserMessages[0].text).toContain("ralphi-convert");
				expect(api.sendUserMessages[0].text).toContain("ralphi_phase_done");

				const runId = extractRunId(api.sendUserMessages[0].text);
				const done = await runtime.markPhaseDone(ctx as any, {
					runId,
					phase: "ralphi-convert",
					summary: "converted PRD",
					outputs: ["prd.json"],
				});
				expect(done.ok).toBe(true);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("loop iteration phase still starts and completes normally", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startLoop(ctx as any, "--max-iterations 2");

				const kickoff = api.sendUserMessages[api.sendUserMessages.length - 1].text;
				expect(kickoff).toContain("ralphi-loop");
				const runId = extractRunId(kickoff);

				const done = await runtime.markPhaseDone(ctx as any, {
					runId,
					phase: "ralphi-loop-iteration",
					summary: "implemented a story",
					complete: true,
					outputs: ["src/feature.ts"],
				});
				expect(done.ok).toBe(true);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("tool description documents phase restriction", () => {
		it("tool description mentions phase restriction", async () => {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);

			const { registerTools } = await import("../src/tools");
			registerTools(api as any, runtime);

			const askTool = api.registeredTools.find((t: any) => t.name === "ralphi_ask_user_question") as any;
			expect(askTool.description).toContain("ralphi-init");
			expect(askTool.description).toContain("ralphi-prd");
		});
	});
});
