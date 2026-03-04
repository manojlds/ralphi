import { describe, expect, it } from "vitest";
import { executeAskUserQuestion } from "../src/ask-tool";
import { createMockUi } from "./factories/pi";

function createMockCtx(options?: { hasUI?: boolean; ui?: ReturnType<typeof createMockUi> }) {
	const ui = options?.ui ?? createMockUi();
	return {
		hasUI: options?.hasUI ?? true,
		ui,
		cwd: process.cwd(),
		sessionManager: { getSessionFile: () => "test.json", getSessionId: () => "test", getLeafId: () => null, getEntries: () => [], getBranch: () => [] },
		isIdle: () => true,
	} as any;
}

describe("ralphi_ask_user_question tool", () => {
	describe("single-select", () => {
		it("returns the selected option", async () => {
			const ui = createMockUi([], [], ["Web app"]);
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "project_type", prompt: "What type of project?", type: "single", options: ["Web app", "CLI tool", "Library"] },
				],
			});

			expect(result.isError).toBe(false);
			expect(result.answers.project_type).toEqual({ selected: ["Web app"] });
			expect(result.text).toContain("project_type: Web app");
			expect(ui.selectCalls).toHaveLength(1);
			expect(ui.selectCalls[0].options).toEqual(["Web app", "CLI tool", "Library"]);
		});

		it("supports Other option with free-text input", async () => {
			const ui = createMockUi([], ["My custom type"], ["Other…"]);
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "project_type", prompt: "What type of project?", type: "single", options: ["Web app", "CLI tool"], allowOther: true },
				],
			});

			expect(result.isError).toBe(false);
			expect(result.answers.project_type).toEqual({ selected: ["Other"], otherText: "My custom type" });
			expect(result.text).toContain('Other: "My custom type"');
		});

		it("returns error when user cancels select", async () => {
			const ui = createMockUi([], [], [undefined]);
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("cancelled");
		});
	});

	describe("multi-select", () => {
		it("allows selecting multiple options then finishing with Done", async () => {
			const ui = createMockUi();
			// First call: select "TypeScript", second call: select Done
			ui.selectResponses = ["TypeScript", "✅ Done (finish selecting)"];
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "languages", prompt: "Which languages?", type: "multi", options: ["TypeScript", "Python", "Go"] },
				],
			});

			expect(result.isError).toBe(false);
			expect(result.answers.languages.selected).toEqual(["TypeScript"]);
			expect(ui.selectCalls).toHaveLength(2);
		});

		it("allows selecting all options without Done appearing when exhausted", async () => {
			const ui = createMockUi();
			ui.selectResponses = ["A", "B"];
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q", prompt: "Pick", type: "multi", options: ["A", "B"] },
				],
			});

			expect(result.isError).toBe(false);
			expect(result.answers.q.selected).toEqual(["A", "B"]);
		});

		it("supports Other in multi-select", async () => {
			const ui = createMockUi();
			ui.selectResponses = ["A", "Other…", "✅ Done (finish selecting)"];
			ui.inputResponses = ["Custom answer"];
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q", prompt: "Pick", type: "multi", options: ["A", "B"], allowOther: true },
				],
			});

			expect(result.isError).toBe(false);
			expect(result.answers.q.selected).toContain("A");
			expect(result.answers.q.selected).toContain("Other");
			expect(result.answers.q.otherText).toBe("Custom answer");
		});

		it("returns error when user cancels first multi-select", async () => {
			const ui = createMockUi();
			ui.selectResponses = [undefined];
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q", prompt: "Pick", type: "multi", options: ["A", "B"] },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("cancelled");
		});
	});

	describe("multiple questions", () => {
		it("asks all questions in sequence and returns combined answers", async () => {
			const ui = createMockUi();
			ui.selectResponses = ["Web app", "TypeScript", "✅ Done (finish selecting)"];
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "type", prompt: "Project type?", type: "single", options: ["Web app", "CLI tool"] },
					{ id: "lang", prompt: "Languages?", type: "multi", options: ["TypeScript", "Python"] },
				],
			});

			expect(result.isError).toBe(false);
			expect(result.answers.type.selected).toEqual(["Web app"]);
			expect(result.answers.lang.selected).toEqual(["TypeScript"]);
			expect(result.text).toContain("type: Web app");
			expect(result.text).toContain("lang: TypeScript");
		});

		it("stops and returns error if user cancels a later question", async () => {
			const ui = createMockUi();
			ui.selectResponses = ["Web app", undefined]; // cancel second question
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "type", prompt: "Project type?", type: "single", options: ["Web app", "CLI tool"] },
					{ id: "lang", prompt: "Languages?", type: "multi", options: ["TypeScript", "Python"] },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.answers.type).toBeDefined();
			expect(result.answers.lang).toBeUndefined();
		});
	});

	describe("headless mode (no UI)", () => {
		it("returns error with question list when UI is not available", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("Interactive UI is not available");
			expect(result.text).toContain("q1");
			expect(result.text).toContain("Pick one");
			expect(result.text).toContain("A, B");
		});
	});

	describe("tool registration", () => {
		it("registers ralphi_ask_user_question tool via registerTools", async () => {
			const { createMockExtensionApi, createMockSessionManager } = await import("./factories/pi");
			const { registerTools } = await import("../src/tools");
			const { RalphiRuntime } = await import("../src/runtime");

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);

			registerTools(api as any, runtime);

			expect(api.registeredTools).toHaveLength(2);
			const toolNames = api.registeredTools.map((t: any) => t.name);
			expect(toolNames).toContain("ralphi_phase_done");
			expect(toolNames).toContain("ralphi_ask_user_question");
		});
	});

	describe("edge cases", () => {
		it("handles empty options list gracefully", async () => {
			const ui = createMockUi();
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q", prompt: "Pick", type: "single", options: [] },
				],
			});

			expect(result.isError).toBe(false);
			expect(result.answers.q.selected).toEqual([]);
		});

		it("handles empty options list in multi-select", async () => {
			const ui = createMockUi();
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q", prompt: "Pick", type: "multi", options: [] },
				],
			});

			expect(result.isError).toBe(false);
			expect(result.answers.q.selected).toEqual([]);
		});

		it("returns error when user cancels Other input for single-select", async () => {
			const ui = createMockUi();
			ui.selectResponses = ["Other…"];
			ui.inputResponses = [undefined];
			const ctx = createMockCtx({ ui });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q", prompt: "Pick", type: "single", options: ["A"], allowOther: true },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("cancelled");
		});
	});
});
