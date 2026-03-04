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

const ProvidedAnswerSchema = Type.Object({
	selected: Type.Array(Type.String(), {
		description: "Selected option(s). For single-select: exactly one. For multi-select: one or more.",
	}),
	otherText: Type.Optional(
		Type.String({ description: "Free-text value when 'Other' is selected (requires allowOther on the question)" }),
	),
});

export const AskUserQuestionParams = Type.Object({
	questions: Type.Array(QuestionSchema, {
		description: "One or more structured questions to ask the user",
		minItems: 1,
	}),
	providedAnswers: Type.Optional(
		Type.Record(Type.String(), ProvidedAnswerSchema, {
			description:
				"Pre-supplied answers keyed by question ID, for headless/non-interactive use. " +
				"When provided, skips interactive UI and uses these answers directly. " +
				'Example: { "project_type": { "selected": ["Web app"] }, "lang": { "selected": ["Other"], "otherText": "Rust" } }',
		}),
	),
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

function validateProvidedAnswers(
	questions: QuestionInput[],
	providedAnswers: Record<string, { selected: string[]; otherText?: string }>,
): { valid: true; answers: Record<string, QuestionAnswer> } | { valid: false; errors: string[] } {
	const errors: string[] = [];
	const validated: Record<string, QuestionAnswer> = {};

	for (const question of questions) {
		const answer = providedAnswers[question.id];
		if (!answer) {
			errors.push(`Missing answer for question "${question.id}" ("${question.prompt}").`);
			continue;
		}

		if (!Array.isArray(answer.selected)) {
			errors.push(`Answer for "${question.id}" must have a "selected" array.`);
			continue;
		}

		if (question.type === "single" && answer.selected.length !== 1) {
			errors.push(
				`Question "${question.id}" is single-select: provide exactly 1 selection, got ${answer.selected.length}.`,
			);
			continue;
		}

		if (question.type === "multi" && answer.selected.length === 0) {
			errors.push(`Question "${question.id}" is multi-select: provide at least 1 selection.`);
			continue;
		}

		const validOptions = new Set(question.options);
		if (question.allowOther) validOptions.add("Other");

		for (const sel of answer.selected) {
			if (!validOptions.has(sel)) {
				errors.push(
					`Invalid selection "${sel}" for question "${question.id}". Valid options: ${[...validOptions].join(", ")}.`,
				);
			}
		}

		if (answer.selected.includes("Other") && !question.allowOther) {
			errors.push(`Question "${question.id}" does not allow "Other" selections.`);
		}

		if (answer.selected.includes("Other") && (!answer.otherText || answer.otherText.trim().length === 0)) {
			errors.push(
				`Question "${question.id}" has "Other" selected but no "otherText" provided. Supply a free-text value.`,
			);
		}

		if (!errors.length || !errors.some((e) => e.includes(question.id))) {
			validated[question.id] = {
				selected: answer.selected,
				...(answer.otherText ? { otherText: answer.otherText.trim() } : {}),
			};
		}
	}

	// Check for extra keys not matching any question
	const questionIds = new Set(questions.map((q) => q.id));
	for (const key of Object.keys(providedAnswers)) {
		if (!questionIds.has(key)) {
			errors.push(`Unknown question ID "${key}" in providedAnswers. Valid IDs: ${[...questionIds].join(", ")}.`);
		}
	}

	if (errors.length > 0) return { valid: false, errors };
	return { valid: true, answers: validated };
}

function buildHeadlessErrorMessage(questions: QuestionInput[]): string {
	const lines: string[] = [
		"Interactive UI is not available (headless mode). Cannot ask user questions interactively.",
		"",
		"To continue, re-call this tool with a \"providedAnswers\" parameter containing answers for each question.",
		"",
		"Questions that need answers:",
	];

	for (const q of questions) {
		lines.push(`  - ${q.id} (${q.type}-select): "${q.prompt}"`);
		lines.push(`    Options: ${q.options.join(", ")}${q.allowOther ? ", Other (free-text via otherText)" : ""}`);
	}

	// Build a concrete JSON example
	const example: Record<string, { selected: string[]; otherText?: string }> = {};
	for (const q of questions) {
		if (q.type === "single") {
			example[q.id] = { selected: [q.options[0] ?? "YourChoice"] };
		} else {
			example[q.id] = { selected: q.options.length > 0 ? [q.options[0]] : ["YourChoice"] };
		}
	}

	lines.push("");
	lines.push("Example providedAnswers:");
	lines.push(JSON.stringify(example, null, 2));

	return lines.join("\n");
}

export async function executeAskUserQuestion(ctx: ExtensionContext, params: AskUserQuestionInput): Promise<AskToolResult> {
	// Headless mode: use providedAnswers if available, otherwise fail with actionable error
	if (!ctx.hasUI) {
		if (params.providedAnswers && Object.keys(params.providedAnswers).length > 0) {
			const validation = validateProvidedAnswers(params.questions, params.providedAnswers);
			if (!validation.valid) {
				return {
					text: `Provided answers failed validation:\n${validation.errors.map((e) => `  - ${e}`).join("\n")}\n\nFix the errors above and re-call the tool with corrected providedAnswers.`,
					answers: {},
					isError: true,
				};
			}

			const summaryParts: string[] = [];
			for (const question of params.questions) {
				const answer = validation.answers[question.id];
				const displayValues = answer.otherText
					? [...answer.selected.filter((s) => s !== "Other"), `Other: "${answer.otherText}"`]
					: answer.selected;
				summaryParts.push(`${question.id}: ${displayValues.join(", ") || "(none)"}`);
			}

			return {
				text: summaryParts.join("\n"),
				answers: validation.answers,
				isError: false,
			};
		}

		return {
			text: buildHeadlessErrorMessage(params.questions),
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
