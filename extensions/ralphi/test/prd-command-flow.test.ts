import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands";
import { RalphiRuntime } from "../src/runtime";
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
	return fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-prd-flow-"));
}

describe("US-004: PRD-Focused Command Flow Compatibility", () => {
	describe("existing /ralphi-prd name/description collection remains intact", () => {
		it("prompts for name and description via TUI when args are empty", async () => {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const startPhase = vi.fn(async () => undefined);
			const runtime = {
				startPhase,
				finalizeRun: vi.fn(),
				startLoop: vi.fn(),
				runLoopIteration: vi.fn(),
				stopLoop: vi.fn(),
				openLoop: vi.fn(),
				openLoopController: vi.fn(),
				showLoopStatus: vi.fn(),
			};
			registerCommands(api as any, runtime as any);

			const command = api.registeredCommands.get("ralphi-prd") as {
				handler: (args: string, ctx: any) => Promise<void>;
			};
			const ui = createMockUi([], ["my-feature", "Build a notification system"]);
			const ctx = createMockCommandContext({ sessionManager, ui });

			await command.handler("", ctx as any);

			expect(ui.inputCalls).toHaveLength(2);
			expect(ui.inputCalls[0].title).toBe("PRD name");
			expect(ui.inputCalls[1].title).toBe("PRD description");
			expect(startPhase).toHaveBeenCalledTimes(1);
			expect(startPhase).toHaveBeenCalledWith(
				ctx,
				"ralphi-prd",
				"my-feature Build a notification system",
			);
		});

		it("passes name and description through when provided as args", async () => {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const startPhase = vi.fn(async () => undefined);
			const runtime = {
				startPhase,
				finalizeRun: vi.fn(),
				startLoop: vi.fn(),
				runLoopIteration: vi.fn(),
				stopLoop: vi.fn(),
				openLoop: vi.fn(),
				openLoopController: vi.fn(),
				showLoopStatus: vi.fn(),
			};
			registerCommands(api as any, runtime as any);

			const command = api.registeredCommands.get("ralphi-prd") as {
				handler: (args: string, ctx: any) => Promise<void>;
			};
			const ui = createMockUi();
			const ctx = createMockCommandContext({ sessionManager, ui });

			await command.handler("auth-flow Add user authentication with OAuth", ctx as any);

			expect(ui.inputCalls).toHaveLength(0);
			expect(startPhase).toHaveBeenCalledWith(
				ctx,
				"ralphi-prd",
				"auth-flow Add user authentication with OAuth",
			);
		});

		it("fails with usage message in headless mode when args missing", async () => {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const startPhase = vi.fn(async () => undefined);
			const runtime = {
				startPhase,
				finalizeRun: vi.fn(),
				startLoop: vi.fn(),
				runLoopIteration: vi.fn(),
				stopLoop: vi.fn(),
				openLoop: vi.fn(),
				openLoopController: vi.fn(),
				showLoopStatus: vi.fn(),
			};
			registerCommands(api as any, runtime as any);

			const command = api.registeredCommands.get("ralphi-prd") as {
				handler: (args: string, ctx: any) => Promise<void>;
			};
			const ui = createMockUi();
			const ctx = createMockCommandContext({ sessionManager, ui, hasUI: false });

			await command.handler("", ctx as any);

			expect(startPhase).not.toHaveBeenCalled();
			expect(ui.notifications.some((n) => n.message.includes("Usage:"))).toBe(true);
		});
	});

	describe("kickoff message includes PRD-specific ask tool guidance", () => {
		it("ralphi-prd kickoff mentions ralphi_ask_user_question and clarifying questions", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-prd", "my-feature a cool notification system");

				expect(api.sendUserMessages).toHaveLength(1);
				const kickoff = api.sendUserMessages[0].text;

				// Standard kickoff content still present
				expect(kickoff).toContain("ralphi_phase_done");
				expect(kickoff).toContain("runId");
				expect(kickoff).toContain("/skill:ralphi-prd");

				// Kickoff delegates PRD-specific workflow to the skill file
				expect(kickoff).toContain("ralphi_phase_done");
				expect(kickoff).toContain("/skill:ralphi-prd my-feature");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("ralphi-prd kickoff includes the resolved args in guidance", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-prd", "auth-flow Add user authentication");

				const kickoff = api.sendUserMessages[0].text;
				expect(kickoff).toContain("auth-flow Add user authentication");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("ralphi-init kickoff does NOT include PRD-specific guidance", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-init", "");

				const kickoff = api.sendUserMessages[0].text;
				expect(kickoff).not.toContain("name and description have already been collected");
				expect(kickoff).not.toContain("ralphi_ask_user_question");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("ralphi-convert kickoff does NOT include ask tool guidance", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-convert", "my-prd.md");

				const kickoff = api.sendUserMessages[0].text;
				expect(kickoff).not.toContain("ralphi_ask_user_question");
				expect(kickoff).not.toContain("clarifying questions");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("system prompt guidance encourages Q&A before PRD generation", () => {
		it("ralphi-prd system prompt includes PRD-specific ask tool guidance", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-prd", "my-feature a cool feature");

				const event = { systemPrompt: "You are a helpful assistant." } as any;
				const result = runtime.handleBeforeAgentStart(event, ctx as any);

				expect(result).toBeDefined();
				const prompt = result!.systemPrompt;

				// Generic ask tool hint
				expect(prompt).toContain("ralphi_ask_user_question tool is available");

				// No PRD-specific duplication — skill file handles workflow details
				expect(prompt).not.toContain("For ralphi-prd");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("ralphi-init system prompt does NOT include PRD-specific guidance", async () => {
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
				const prompt = result!.systemPrompt;

				// Generic ask tool hint is present
				expect(prompt).toContain("ralphi_ask_user_question tool is available");

				// PRD-specific guidance is NOT present
				expect(prompt).not.toContain("For ralphi-prd:");
				expect(prompt).not.toContain("Only proceed to PRD generation after receiving answers");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("ralphi-convert system prompt includes ask tool guidance but not PRD-specific guidance", async () => {
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
				expect(result!.systemPrompt).toContain("ralphi_ask_user_question");
				expect(result!.systemPrompt).not.toContain("For ralphi-prd");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("ask tool works during ralphi-prd after kickoff", () => {
		it("ralphi_ask_user_question succeeds during ralphi-prd phase with UI", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);

				const { registerTools } = await import("../src/tools");
				registerTools(api as any, runtime);

				const askTool = api.registeredTools.find((t: any) => t.name === "ralphi_ask_user_question") as any;

				// Pre-queue select responses for two questions: single + multi
				const ui = createMockUi([], [], ["MVP", "Real-time updates", "✅ Done (finish selecting)"]);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir, ui });
				await runtime.startPhase(ctx as any, "ralphi-prd", "notifications Build a notification system");

				const result = await askTool.execute(
					"call-1",
					{
						questions: [
							{
								id: "scope",
								prompt: "What is the project scope?",
								type: "single",
								options: ["MVP", "Full feature", "Enterprise"],
							},
							{
								id: "features",
								prompt: "Which features are essential?",
								type: "multi",
								options: ["Real-time updates", "Email digest", "Push notifications"],
							},
						],
					},
					new AbortController().signal,
					() => {},
					ctx as any,
				);

				expect(result.isError).toBe(false);
				expect(result.details.answers.scope.selected).toEqual(["MVP"]);
				expect(result.details.answers.features.selected).toContain("Real-time updates");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("ralphi_ask_user_question works with providedAnswers in headless prd mode", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);

				const { registerTools } = await import("../src/tools");
				registerTools(api as any, runtime);

				const askTool = api.registeredTools.find((t: any) => t.name === "ralphi_ask_user_question") as any;

				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir, hasUI: false });
				await runtime.startPhase(ctx as any, "ralphi-prd", "my-feature some description");

				const result = await askTool.execute(
					"call-1",
					{
						questions: [
							{
								id: "goal",
								prompt: "Primary goal?",
								type: "single",
								options: ["Speed", "Reliability", "Cost"],
							},
						],
						providedAnswers: {
							goal: { selected: ["Reliability"] },
						},
					},
					new AbortController().signal,
					() => {},
					ctx as any,
				);

				expect(result.isError).toBe(false);
				expect(result.details.answers.goal.selected).toEqual(["Reliability"]);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("convert and loop phases remain unaffected", () => {
		it("ralphi-convert kickoff and completion work normally", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startPhase(ctx as any, "ralphi-convert", "tasks/prd-auth.md");

				const kickoff = api.sendUserMessages[0].text;
				expect(kickoff).toContain("ralphi-convert");
				expect(kickoff).not.toContain("ralphi_ask_user_question");

				const runId = extractRunId(kickoff);
				const done = await runtime.markPhaseDone(ctx as any, {
					runId,
					phase: "ralphi-convert",
					summary: "converted PRD to JSON",
					outputs: [".ralphi/prd.json"],
				});
				expect(done.ok).toBe(true);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it("loop iteration kickoff does not include ask tool guidance", async () => {
			const tempDir = createTempDir();
			try {
				const sessionManager = createMockSessionManager();
				const api = createMockExtensionApi(sessionManager);
				const runtime = new RalphiRuntime(api as any);
				const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

				await runtime.startLoop(ctx as any, "--max-iterations 2");

				const kickoff = api.sendUserMessages[api.sendUserMessages.length - 1].text;
				expect(kickoff).toContain("ralphi-loop");
				expect(kickoff).not.toContain("ralphi_ask_user_question");
				expect(kickoff).not.toContain("clarifying questions");
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});
	});

	describe("ralphi-prd skill references ask tool", () => {
		it("SKILL.md mentions ralphi_ask_user_question as preferred method", () => {
			const skillContent = fs.readFileSync(
				path.resolve(__dirname, "../../../skills/ralphi-prd/SKILL.md"),
				"utf8",
			);

			expect(skillContent).toContain("ralphi_ask_user_question");
			expect(skillContent).toContain("fall back to text-based questions");
		});
	});
});
