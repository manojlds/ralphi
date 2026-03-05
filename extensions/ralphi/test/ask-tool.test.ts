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
		it("returns actionable error with question details and example when UI is not available", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("Interactive UI is not available (headless mode)");
			expect(result.text).toContain("providedAnswers");
			expect(result.text).toContain("q1 (single-select)");
			expect(result.text).toContain("Pick one");
			expect(result.text).toContain("Options: A, B");
			expect(result.text).toContain("Example providedAnswers:");
			expect(result.text).toContain('"q1"');
			expect(result.text).toContain('"selected"');
		});

		it("includes question type and allowOther info in error message", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "lang", prompt: "Languages?", type: "multi", options: ["TS", "Python"], allowOther: true },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("lang (multi-select)");
			expect(result.text).toContain("Other (free-text via otherText)");
		});

		it("includes all questions in the error message", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "First?", type: "single", options: ["A", "B"] },
					{ id: "q2", prompt: "Second?", type: "multi", options: ["X", "Y", "Z"] },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("q1 (single-select)");
			expect(result.text).toContain("q2 (multi-select)");
			expect(result.text).toContain("Example providedAnswers:");
		});

		it("never silently falls back to defaults when no providedAnswers and no UI", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] },
				],
			});

			expect(result.isError).toBe(true);
			expect(result.answers).toEqual({});
			// Must NOT have selected any default answer
			expect(result.answers).not.toHaveProperty("q1");
		});
	});

	describe("headless mode with providedAnswers", () => {
		it("accepts valid providedAnswers for single-select", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] },
				],
				providedAnswers: {
					q1: { selected: ["B"] },
				},
			});

			expect(result.isError).toBe(false);
			expect(result.answers.q1).toEqual({ selected: ["B"] });
			expect(result.text).toContain("q1: B");
		});

		it("accepts valid providedAnswers for multi-select", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "langs", prompt: "Languages?", type: "multi", options: ["TS", "Python", "Go"] },
				],
				providedAnswers: {
					langs: { selected: ["TS", "Go"] },
				},
			});

			expect(result.isError).toBe(false);
			expect(result.answers.langs).toEqual({ selected: ["TS", "Go"] });
			expect(result.text).toContain("langs: TS, Go");
		});

		it("accepts Other with otherText in providedAnswers", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick", type: "single", options: ["A", "B"], allowOther: true },
				],
				providedAnswers: {
					q1: { selected: ["Other"], otherText: "Custom value" },
				},
			});

			expect(result.isError).toBe(false);
			expect(result.answers.q1).toEqual({ selected: ["Other"], otherText: "Custom value" });
			expect(result.text).toContain('Other: "Custom value"');
		});

		it("accepts multiple questions with providedAnswers", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "type", prompt: "Project type?", type: "single", options: ["Web", "CLI"] },
					{ id: "langs", prompt: "Languages?", type: "multi", options: ["TS", "Python"] },
				],
				providedAnswers: {
					type: { selected: ["Web"] },
					langs: { selected: ["TS", "Python"] },
				},
			});

			expect(result.isError).toBe(false);
			expect(result.answers.type.selected).toEqual(["Web"]);
			expect(result.answers.langs.selected).toEqual(["TS", "Python"]);
		});

		it("rejects when a required question ID is missing from providedAnswers", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "First?", type: "single", options: ["A"] },
					{ id: "q2", prompt: "Second?", type: "single", options: ["X"] },
				],
				providedAnswers: {
					q1: { selected: ["A"] },
					// q2 is missing
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain('Missing answer for question "q2"');
			expect(result.text).toContain("Fix the errors above");
		});

		it("rejects single-select with more than one selection", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B", "C"] },
				],
				providedAnswers: {
					q1: { selected: ["A", "B"] },
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("single-select: provide exactly 1 selection, got 2");
		});

		it("rejects single-select with zero selections", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick one", type: "single", options: ["A", "B"] },
				],
				providedAnswers: {
					q1: { selected: [] },
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("single-select: provide exactly 1 selection, got 0");
		});

		it("rejects multi-select with zero selections", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick some", type: "multi", options: ["A", "B"] },
				],
				providedAnswers: {
					q1: { selected: [] },
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain("multi-select: provide at least 1 selection");
		});

		it("rejects invalid option values", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick", type: "single", options: ["A", "B"] },
				],
				providedAnswers: {
					q1: { selected: ["C"] },
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain('Invalid selection "C"');
			expect(result.text).toContain("Valid options: A, B");
		});

		it("rejects Other selection when allowOther is not set", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick", type: "single", options: ["A", "B"] },
				],
				providedAnswers: {
					q1: { selected: ["Other"], otherText: "Something" },
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain('does not allow "Other" selections');
		});

		it("rejects Other selection with missing otherText", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick", type: "single", options: ["A"], allowOther: true },
				],
				providedAnswers: {
					q1: { selected: ["Other"] },
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain('"Other" selected but no "otherText" provided');
		});

		it("rejects Other selection with empty otherText", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick", type: "single", options: ["A"], allowOther: true },
				],
				providedAnswers: {
					q1: { selected: ["Other"], otherText: "   " },
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain('"Other" selected but no "otherText" provided');
		});

		it("rejects unknown question IDs in providedAnswers", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick", type: "single", options: ["A"] },
				],
				providedAnswers: {
					q1: { selected: ["A"] },
					q_unknown: { selected: ["X"] },
				},
			});

			expect(result.isError).toBe(true);
			expect(result.text).toContain('Unknown question ID "q_unknown"');
		});

		it("trims otherText whitespace in providedAnswers", async () => {
			const ctx = createMockCtx({ hasUI: false });

			const result = await executeAskUserQuestion(ctx, {
				questions: [
					{ id: "q1", prompt: "Pick", type: "single", options: ["A"], allowOther: true },
				],
				providedAnswers: {
					q1: { selected: ["Other"], otherText: "  Custom value  " },
				},
			});

			expect(result.isError).toBe(false);
			expect(result.answers.q1.otherText).toBe("Custom value");
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
