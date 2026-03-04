import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

const DONE_SENTINEL = "✅ Done (finish selecting)";
const OTHER_SENTINEL = "Other…";

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question (e.g. 'project_type')" }),
	prompt: Type.String({ description: "The question text to display to the user" }),
	type: StringEnum(["single", "multi"], { description: "single = pick one, multi = pick one or more" }),
	options: Type.Array(Type.String(), { description: "Selectable options to present" }),
	allowOther: Type.Optional(
		Type.Boolean({ description: "When true, adds an 'Other…' option that opens a free-text input" }),
	),
});

export const AskUserQuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "One or more structured questions to ask the user",
		minItems: 1,
	}),
});

export type AskUserQuestionInput = Static<typeof AskUserQuestionParams>;
export type QuestionInput = Static<typeof QuestionSchema>;

export interface QuestionAnswer {
	selected: string[];
	otherText?: string;
}

export interface AskToolResult {
	text: string;
	answers: Record<string, QuestionAnswer>;
	isError: boolean;
}

function buildOptionList(question: QuestionInput, excludeSelected?: Set<string>, includeDone?: boolean): string[] {
	const opts: string[] = [];
	if (includeDone) opts.push(DONE_SENTINEL);
	for (const opt of question.options) {
		if (!excludeSelected || !excludeSelected.has(opt)) {
			opts.push(opt);
		}
	}
	if (question.allowOther) opts.push(OTHER_SENTINEL);
	return opts;
}

async function askSingleSelect(ctx: ExtensionContext, question: QuestionInput): Promise<QuestionAnswer | null> {
	const options = buildOptionList(question);
	if (options.length === 0) {
		return { selected: [] };
	}

	const choice = await ctx.ui.select(question.prompt, options);
	if (choice === undefined) return null;

	if (choice === OTHER_SENTINEL) {
		const otherText = await ctx.ui.input(`${question.prompt} (specify)`, "Type your answer…");
		if (otherText === undefined) return null;
		return { selected: ["Other"], otherText: otherText.trim() };
	}

	return { selected: [choice] };
}

async function askMultiSelect(ctx: ExtensionContext, question: QuestionInput): Promise<QuestionAnswer | null> {
	const selected = new Set<string>();
	let otherText: string | undefined;

	// First selection (no Done option yet)
	const firstOptions = buildOptionList(question);
	if (firstOptions.length === 0) {
		return { selected: [] };
	}

	const firstChoice = await ctx.ui.select(`${question.prompt} (select one or more)`, firstOptions);
	if (firstChoice === undefined) return null;

	if (firstChoice === OTHER_SENTINEL) {
		const text = await ctx.ui.input(`${question.prompt} (specify)`, "Type your answer…");
		if (text === undefined) return null;
		otherText = text.trim();
		selected.add("Other");
	} else {
		selected.add(firstChoice);
	}

	// Subsequent selections with Done option
	while (true) {
		const remaining = buildOptionList(question, selected, true);
		// Only Done sentinel remains or no options left
		if (remaining.length <= 1) break;

		const choice = await ctx.ui.select(
			`${question.prompt} (selected: ${[...selected].join(", ")}${otherText ? ` [Other: ${otherText}]` : ""})`,
			remaining,
		);

		if (choice === undefined || choice === DONE_SENTINEL) break;

		if (choice === OTHER_SENTINEL) {
			const text = await ctx.ui.input(`${question.prompt} (specify)`, "Type your answer…");
			if (text !== undefined && text.trim().length > 0) {
				otherText = text.trim();
				selected.add("Other");
			}
		} else {
			selected.add(choice);
		}
	}

	return { selected: [...selected], ...(otherText ? { otherText } : {}) };
}

export async function executeAskUserQuestion(ctx: ExtensionContext, params: AskUserQuestionInput): Promise<AskToolResult> {
	if (!ctx.hasUI) {
		const questionList = params.questions
			.map((q) => `  - ${q.id}: "${q.prompt}" [options: ${q.options.join(", ")}]`)
			.join("\n");
		return {
			text: `Interactive UI is not available (headless mode). Cannot ask user questions.\n\nQuestions that need answers:\n${questionList}\n\nProvide answers directly in the conversation or as command arguments.`,
			answers: {},
			isError: true,
		};
	}

	const answers: Record<string, QuestionAnswer> = {};
	const summaryParts: string[] = [];

	for (const question of params.questions) {
		const answer =
			question.type === "multi"
				? await askMultiSelect(ctx, question)
				: await askSingleSelect(ctx, question);

		if (answer === null) {
			return {
				text: `User cancelled question: "${question.prompt}" (${question.id})`,
				answers,
				isError: true,
			};
		}

		answers[question.id] = answer;

		const displayValues = answer.otherText
			? [...answer.selected.filter((s) => s !== "Other"), `Other: "${answer.otherText}"`]
			: answer.selected;
		summaryParts.push(`${question.id}: ${displayValues.join(", ") || "(none)"}`);
	}

	return {
		text: summaryParts.join("\n"),
		answers,
		isError: false,
	};
}
