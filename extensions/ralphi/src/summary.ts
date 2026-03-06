import * as fs from "node:fs";
import * as path from "node:path";
import type { PhaseRun } from "./types";

// ---- Types ----

export interface ConfigData {
	projectName?: string;
	language?: string;
	framework?: string;
	engine?: string;
	commands: Record<string, string>;
	rules: string[];
}

export interface PrdMarkdownData {
	title?: string;
	goals: string[];
	stories: Array<{ id: string; title: string }>;
}

export interface PrdJsonData {
	project?: string;
	branchName?: string;
	description?: string;
	stories: Array<{
		id: string;
		title: string;
		priority: number;
		passes: boolean;
	}>;
}

// ---- String parsers (exported for testing) ----

function unquote(s: string): string {
	const trimmed = s.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

export function parseConfigYaml(content: string): ConfigData {
	const result: ConfigData = { commands: {}, rules: [] };
	const lines = content.split(/\r?\n/);

	let currentSection = "";

	for (const line of lines) {
		if (line.trim() === "" || line.trim().startsWith("#")) continue;

		const isIndented = line.startsWith(" ") || line.startsWith("\t");
		const trimmed = line.trim();

		if (!isIndented) {
			// Top-level key: value (value present after colon + space)
			const kvMatch = trimmed.match(/^([\w][\w-]*)\s*:\s+(.+)$/);
			if (kvMatch) {
				currentSection = "";
				if (kvMatch[1] === "engine") result.engine = unquote(kvMatch[2]);
				continue;
			}
			// Section header: "key:" with no value
			const sectionMatch = trimmed.match(/^([\w][\w-]*)\s*:\s*$/);
			if (sectionMatch) {
				currentSection = sectionMatch[1];
			}
			continue;
		}

		// Indented line — within current section
		if (currentSection === "project") {
			const kvMatch = trimmed.match(/^([\w][\w-]*)\s*:\s+(.+)$/);
			if (kvMatch) {
				const key = kvMatch[1];
				const val = unquote(kvMatch[2]);
				if (key === "name") result.projectName = val;
				else if (key === "language") result.language = val;
				else if (key === "framework") result.framework = val;
			}
		} else if (currentSection === "commands") {
			const kvMatch = trimmed.match(/^([\w][\w-]*)\s*:\s+(.+)$/);
			if (kvMatch) {
				result.commands[kvMatch[1]] = unquote(kvMatch[2]);
			}
		} else if (currentSection === "rules") {
			const listMatch = trimmed.match(/^-\s+(.+)$/);
			if (listMatch) {
				result.rules.push(unquote(listMatch[1]));
			}
		}
	}

	return result;
}

export function parsePrdMarkdown(content: string): PrdMarkdownData {
	const result: PrdMarkdownData = { goals: [], stories: [] };

	// Extract title from first # heading
	const titleMatch = content.match(/^#\s+(.+)$/m);
	if (titleMatch) result.title = titleMatch[1].trim();

	// Extract goals section (bullets after ## Goals until next ##)
	const goalsMatch = content.match(/##\s+Goals\s*\n([\s\S]*?)(?=\n##\s|\n$|$)/);
	if (goalsMatch) {
		const bullets = goalsMatch[1].matchAll(/^[-*]\s+(.+)$/gm);
		for (const bullet of bullets) {
			result.goals.push(bullet[1].trim());
		}
	}

	// Extract user stories (### US-xxx: Title)
	const storyMatches = content.matchAll(/###\s+(US-\d+):\s*(.+)$/gm);
	for (const match of storyMatches) {
		result.stories.push({ id: match[1], title: match[2].trim() });
	}

	return result;
}

export function parsePrdJson(raw: string): PrdJsonData | null {
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;

		const stories: PrdJsonData["stories"] = [];
		if (Array.isArray(parsed.userStories)) {
			for (const s of parsed.userStories) {
				if (!s || typeof s !== "object") continue;
				stories.push({
					id: typeof s.id === "string" ? s.id : "",
					title: typeof s.title === "string" ? s.title : "",
					priority: typeof s.priority === "number" ? s.priority : 999,
					passes: s.passes === true,
				});
			}
		}

		return {
			project: typeof parsed.project === "string" ? parsed.project : undefined,
			branchName: typeof parsed.branchName === "string" ? parsed.branchName : undefined,
			description: typeof parsed.description === "string" ? parsed.description : undefined,
			stories,
		};
	} catch {
		return null;
	}
}

// ---- File readers (internal) ----

function readConfigData(cwd: string): ConfigData | null {
	try {
		const content = fs.readFileSync(path.join(cwd, ".ralphi", "config.yaml"), "utf8");
		return parseConfigYaml(content);
	} catch {
		return null;
	}
}

function readPrdJsonFile(cwd: string): PrdJsonData | null {
	try {
		const raw = fs.readFileSync(path.join(cwd, ".ralphi", "prd.json"), "utf8");
		return parsePrdJson(raw);
	} catch {
		return null;
	}
}

function readPrdMarkdownFile(filePath: string): PrdMarkdownData | null {
	try {
		const content = fs.readFileSync(filePath, "utf8");
		return parsePrdMarkdown(content);
	} catch {
		return null;
	}
}

// ---- Output formatting ----

function formatOutputs(cwd: string, outputs: string[]): string[] {
	if (outputs.length === 0) return [];
	return outputs.map((out) => {
		const exists = fs.existsSync(path.resolve(cwd, out));
		return `  ${exists ? "✓" : "✗"} ${out}`;
	});
}

// ---- Summary builders ----

export function buildInitSummary(run: PhaseRun): string {
	const lines: string[] = ["[RALPHI INIT COMPLETE]", `Run: ${run.id}`, ""];

	const config = readConfigData(run.cwd);
	if (config) {
		if (config.projectName) lines.push(`Project: ${config.projectName}`);
		if (config.language) lines.push(`Language: ${config.language}`);
		if (config.framework) lines.push(`Framework: ${config.framework}`);
		if (config.engine) lines.push(`Engine: ${config.engine}`);

		const cmdEntries = Object.entries(config.commands);
		if (cmdEntries.length > 0) {
			lines.push("", "Commands:");
			for (const [key, val] of cmdEntries) {
				lines.push(`  ${key}: ${val}`);
			}
		}

		if (config.rules.length > 0) {
			lines.push("", "Rules:");
			for (const rule of config.rules) {
				lines.push(`  - ${rule}`);
			}
		}
	}

	if (run.outputs && run.outputs.length > 0) {
		lines.push("", "Files created/updated:");
		lines.push(...formatOutputs(run.cwd, run.outputs));
	}

	if (run.summary) {
		lines.push("", `Summary: ${run.summary}`);
	}

	return lines.join("\n");
}

export function buildPrdSummary(run: PhaseRun): string {
	const lines: string[] = ["[RALPHI PRD COMPLETE]", `Run: ${run.id}`, ""];

	// Try to find and parse the PRD markdown from outputs
	const prdFile = run.outputs?.find(
		(f) => f.endsWith(".md") && (f.includes("prd-") || f.startsWith("tasks/")),
	);
	let prdData: PrdMarkdownData | null = null;
	if (prdFile) {
		prdData = readPrdMarkdownFile(path.resolve(run.cwd, prdFile));
	}

	if (prdFile) {
		lines.push(`PRD: ${prdFile}`);
	}

	if (prdData) {
		if (prdData.title) lines.push(`Feature: ${prdData.title}`);

		if (prdData.goals.length > 0) {
			lines.push("", "Goals:");
			for (const goal of prdData.goals) {
				lines.push(`  - ${goal}`);
			}
		}

		if (prdData.stories.length > 0) {
			lines.push("", `User Stories (${prdData.stories.length}):`);
			for (const story of prdData.stories) {
				lines.push(`  ${story.id}: ${story.title}`);
			}
		}
	}

	if (run.outputs && run.outputs.length > 0) {
		lines.push("", "Files created/updated:");
		lines.push(...formatOutputs(run.cwd, run.outputs));
	}

	if (run.summary) {
		lines.push("", `Summary: ${run.summary}`);
	}

	return lines.join("\n");
}

export function buildConvertSummary(run: PhaseRun): string {
	const lines: string[] = ["[RALPHI CONVERT COMPLETE]", `Run: ${run.id}`, ""];

	const prd = readPrdJsonFile(run.cwd);
	if (prd) {
		if (prd.project) lines.push(`Project: ${prd.project}`);
		if (prd.branchName) lines.push(`Branch: ${prd.branchName}`);

		if (prd.stories.length > 0) {
			lines.push("", `Stories (${prd.stories.length}):`);
			for (const story of prd.stories) {
				lines.push(`  ${story.id}: ${story.title}`);
			}
		}
	}

	if (run.outputs && run.outputs.length > 0) {
		lines.push("", "Files created/updated:");
		lines.push(...formatOutputs(run.cwd, run.outputs));
	}

	if (run.summary) {
		lines.push("", `Summary: ${run.summary}`);
	}

	return lines.join("\n");
}

export function buildDeterministicSummary(run: PhaseRun): string | undefined {
	switch (run.phase) {
		case "ralphi-init":
			return buildInitSummary(run);
		case "ralphi-prd":
			return buildPrdSummary(run);
		case "ralphi-convert":
			return buildConvertSummary(run);
		case "ralphi-loop-iteration":
			// Loop iterations finalize via session switch, not navigateTree.
			// session_before_tree never fires for them.
			return undefined;
	}
}
