import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { AskUserQuestionParams, executeAskUserQuestion } from "./ask-tool";
import type { RalphiRuntime } from "./runtime";
import { PHASE_KINDS } from "./types";

export function registerTools(pi: ExtensionAPI, runtime: RalphiRuntime) {
	pi.registerTool({
		name: "ralphi_phase_done",
		label: "Ralphi Phase Done",
		description: "Marks a ralphi phase as complete and triggers finalize flow (optional tree summarize + rewind).",
		parameters: Type.Object({
			runId: Type.String({ description: "Run ID supplied by the extension" }),
			phase: StringEnum(PHASE_KINDS, { description: "Phase name" }),
			summary: Type.String({ description: "Summary of completed work" }),
			outputs: Type.Optional(Type.Array(Type.String(), { description: "Key files written/updated" })),
			complete: Type.Optional(Type.Boolean({ description: "Set true when loop work is fully complete" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await runtime.markPhaseDone(ctx, params);
				return {
					content: [{ type: "text", text: result.text }],
					details: {},
					isError: !result.ok,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Internal error in ralphi_phase_done: ${message}` }],
					details: {},
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "ralphi_ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user one or more structured questions with selectable options. " +
			"Supports single-select (pick one) and multi-select (pick one or more) interactions, " +
			"with an optional 'Other' free-text path. Returns answers keyed by question ID.",
		parameters: AskUserQuestionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await executeAskUserQuestion(ctx, params);
			return {
				content: [{ type: "text", text: result.text }],
				details: { answers: result.answers },
				isError: result.isError,
			};
		},
	});
}
