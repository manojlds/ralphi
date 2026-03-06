import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopReviewControls, TrajectoryGuard } from "./types";

export const LOOP_CONFIG_FILE_PATH = path.join(".ralphi", "config.yaml");

export type LoopReflectionConfig = {
	reflectEvery: number | null;
	reflectInstructions: string | null;
};

export type ReflectionCheckpointInfo = {
	cadence: number;
	isCheckpoint: boolean;
	iterationsUntilNext: number;
	nextCheckpointIteration: number;
	instructions: string | null;
};

export type LoopConfigData = {
	rules: string[];
	guidance: string | null;
	controls: LoopReviewControls;
	reflection: LoopReflectionConfig;
};

export const DEFAULT_LOOP_REVIEW_CONTROLS: LoopReviewControls = {
	reviewPasses: 1,
	trajectoryGuard: "off",
};

export const DEFAULT_LOOP_REFLECTION_CONFIG: LoopReflectionConfig = {
	reflectEvery: null,
	reflectInstructions: null,
};

const DEFAULT_REFLECTION_QUESTIONS = [
	"1) Are we still aligned with the active PRD story scope and acceptance criteria?",
	"2) What risks, blockers, or drift signals are emerging?",
	"3) What is the smallest high-confidence plan for the next iteration?",
].join("\n");

export function readLoopConfigYaml(cwd: string, configRelativePath = LOOP_CONFIG_FILE_PATH): string | null {
	const file = path.join(cwd, configRelativePath);
	if (!fs.existsSync(file)) return null;

	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function unquoteYaml(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseTrajectoryGuard(value: string): TrajectoryGuard | null {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	if (normalized === "off" || normalized === "none") return "off";
	if (normalized === "warn" || normalized === "warn_on_drift") return "warn_on_drift";
	if (normalized === "require" || normalized === "require_plan" || normalized === "require_corrective_plan") {
		return "require_corrective_plan";
	}
	return null;
}

export function parseLoopConfigYaml(raw: string): LoopConfigData {
	const config: LoopConfigData = {
		rules: [],
		guidance: null,
		controls: { ...DEFAULT_LOOP_REVIEW_CONTROLS },
		reflection: { ...DEFAULT_LOOP_REFLECTION_CONFIG },
	};

	const lines = raw.replace(/\r\n/g, "\n").split("\n");
	let section = "";
	let loopTextTarget: "none" | "guidance" | "reflectinstructions" = "none";
	let loopTextMode: "none" | "list" | "block" = "none";
	const guidanceLines: string[] = [];
	const reflectInstructionLines: string[] = [];

	const resetLoopTextCapture = () => {
		loopTextTarget = "none";
		loopTextMode = "none";
	};

	const targetTextLines = () => {
		if (loopTextTarget === "guidance") return guidanceLines;
		if (loopTextTarget === "reflectinstructions") return reflectInstructionLines;
		return null;
	};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const indent = line.length - line.trimStart().length;

		if (indent === 0) {
			const topLevel = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
			section = topLevel ? topLevel[1] : "";
			resetLoopTextCapture();
			continue;
		}

		if (section === "rules") {
			const listItem = trimmed.match(/^-\s+(.+)$/);
			if (listItem) {
				config.rules.push(unquoteYaml(listItem[1]));
			}
			continue;
		}

		if (section !== "loop") continue;

		if (indent <= 2) {
			const kv = trimmed.match(/^([\w-]+)\s*:\s*(.*)$/);
			if (!kv) {
				resetLoopTextCapture();
				continue;
			}

			const key = kv[1].toLowerCase();
			const value = kv[2].trim();
			if (key === "reviewpasses") {
				const parsed = Number.parseInt(unquoteYaml(value), 10);
				if (Number.isFinite(parsed) && parsed > 0) {
					config.controls.reviewPasses = parsed;
				}
				resetLoopTextCapture();
				continue;
			}
			if (key === "trajectoryguard") {
				const guard = parseTrajectoryGuard(unquoteYaml(value));
				if (guard) config.controls.trajectoryGuard = guard;
				resetLoopTextCapture();
				continue;
			}
			if (key === "reflectevery") {
				const parsed = Number.parseInt(unquoteYaml(value), 10);
				config.reflection.reflectEvery = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
				resetLoopTextCapture();
				continue;
			}
			if (key === "guidance" || key === "reflectinstructions") {
				const normalizedKey = key as "guidance" | "reflectinstructions";
				if (!value) {
					loopTextTarget = normalizedKey;
					loopTextMode = "list";
					const linesForKey = normalizedKey === "guidance" ? guidanceLines : reflectInstructionLines;
					linesForKey.length = 0;
					continue;
				}
				if (value === "|" || value === ">") {
					loopTextTarget = normalizedKey;
					loopTextMode = "block";
					const linesForKey = normalizedKey === "guidance" ? guidanceLines : reflectInstructionLines;
					linesForKey.length = 0;
					continue;
				}

				const resolved = unquoteYaml(value) || null;
				if (normalizedKey === "guidance") {
					config.guidance = resolved;
				} else {
					config.reflection.reflectInstructions = resolved;
				}
				resetLoopTextCapture();
				continue;
			}
			resetLoopTextCapture();
			continue;
		}

		if (loopTextMode === "list") {
			const listItem = trimmed.match(/^-\s+(.+)$/);
			if (!listItem) continue;
			const linesForTarget = targetTextLines();
			if (linesForTarget) {
				linesForTarget.push(unquoteYaml(listItem[1]));
			}
			continue;
		}

		if (loopTextMode === "block" && indent >= 4) {
			const linesForTarget = targetTextLines();
			if (linesForTarget) {
				linesForTarget.push(line.slice(4));
			}
		}
	}

	if (!config.guidance && guidanceLines.length > 0) {
		const compact = guidanceLines.map((part) => part.trim()).filter(Boolean);
		config.guidance = compact.join("\n") || null;
	}
	if (!config.reflection.reflectInstructions && reflectInstructionLines.length > 0) {
		const compact = reflectInstructionLines.map((part) => part.trim()).filter(Boolean);
		config.reflection.reflectInstructions = compact.join("\n") || null;
	}

	return config;
}

export function loadLoopConfigData(cwd: string, configRelativePath = LOOP_CONFIG_FILE_PATH): LoopConfigData {
	const raw = readLoopConfigYaml(cwd, configRelativePath);
	if (!raw) {
		return {
			rules: [],
			guidance: null,
			controls: { ...DEFAULT_LOOP_REVIEW_CONTROLS },
			reflection: { ...DEFAULT_LOOP_REFLECTION_CONFIG },
		};
	}
	return parseLoopConfigYaml(raw);
}

export function hasAdvancedLoopReviewControls(controls: LoopReviewControls): boolean {
	return controls.reviewPasses > 1 || controls.trajectoryGuard !== "off";
}

export function hasReflectionConfig(reflection: LoopReflectionConfig): boolean {
	return reflection.reflectEvery !== null || Boolean(reflection.reflectInstructions?.trim());
}

export function reflectionCheckpointInfo(cwd: string, iteration: number, configRelativePath = LOOP_CONFIG_FILE_PATH): ReflectionCheckpointInfo | null {
	const config = loadLoopConfigData(cwd, configRelativePath);
	const cadence = config.reflection.reflectEvery;
	if (!cadence || cadence <= 0) return null;

	const safeIteration = Number.isFinite(iteration) && iteration > 0 ? Math.floor(iteration) : 0;
	const remainder = safeIteration % cadence;
	const isCheckpoint = safeIteration > 0 && remainder === 0;
	const iterationsUntilNext = isCheckpoint || remainder === 0 ? cadence : cadence - remainder;
	const nextCheckpointIteration = safeIteration + iterationsUntilNext;
	const instructions = config.reflection.reflectInstructions?.trim() || null;

	return {
		cadence,
		isCheckpoint,
		iterationsUntilNext,
		nextCheckpointIteration,
		instructions,
	};
}

export function reflectionCountdownLabel(info: ReflectionCheckpointInfo): string {
	const unit = info.iterationsUntilNext === 1 ? "iteration" : "iterations";
	if (info.isCheckpoint) {
		return `reflection checkpoint now (next in ${info.iterationsUntilNext} ${unit}, iter ${info.nextCheckpointIteration})`;
	}
	return `next reflection in ${info.iterationsUntilNext} ${unit} (iter ${info.nextCheckpointIteration})`;
}

export function renderReflectionPromptBlock(iteration: number, info: ReflectionCheckpointInfo): string {
	const lines = [
		"[REFLECTION CHECKPOINT]",
		`Iteration ${iteration} hit loop.reflectEvery=${info.cadence}. Run a structured reflection pass before implementation continues.`,
		"",
		info.instructions
			? `Project reflection instructions (loop.reflectInstructions):\n${info.instructions}`
			: "Project reflection instructions (loop.reflectInstructions):\n(default template)",
		"",
		"Checkpoint questions (answer explicitly):",
		DEFAULT_REFLECTION_QUESTIONS,
		"",
		"Required outputs before calling ralphi_phase_done:",
		"- reflectionSummary: concise findings and confidence level",
		"- trajectory: ON_TRACK | RISK | DRIFT (with trajectoryNotes for RISK/DRIFT)",
		"- nextIterationPlan: concrete, ordered next steps",
	];
	return lines.join("\n");
}

export function renderLoopConfigSection(
	guidance: string | null,
	controls: LoopReviewControls,
	reflection: LoopReflectionConfig,
): string[] {
	const lines: string[] = ["loop:"];
	if (guidance && guidance.trim().length > 0) {
		lines.push(`  guidance: ${JSON.stringify(guidance.trim())}`);
	}
	lines.push(`  reviewPasses: ${controls.reviewPasses}`);
	lines.push(`  trajectoryGuard: ${JSON.stringify(controls.trajectoryGuard)}`);
	if (reflection.reflectEvery !== null) {
		lines.push(`  reflectEvery: ${reflection.reflectEvery}`);
	}
	if (reflection.reflectInstructions && reflection.reflectInstructions.trim().length > 0) {
		lines.push(`  reflectInstructions: ${JSON.stringify(reflection.reflectInstructions.trim())}`);
	}
	return lines;
}

export function upsertLoopSection(raw: string, sectionLines: string[] | null): string {
	const normalized = raw.replace(/\r\n/g, "\n");
	const lines = normalized.split("\n");
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trim() === "loop:") {
			start = i;
			break;
		}
	}

	if (start === -1) {
		if (!sectionLines) return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
		const trimmed = normalized.trimEnd();
		const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
		return `${prefix}${sectionLines.join("\n")}\n`;
	}

	let end = start + 1;
	for (; end < lines.length; end++) {
		const line = lines[end];
		const trimmed = line.trim();
		if (!trimmed) continue;
		const indent = line.length - line.trimStart().length;
		if (indent === 0) break;
	}

	const before = lines.slice(0, start);
	const after = lines.slice(end);
	const merged = sectionLines ? [...before, ...sectionLines, ...after] : [...before, ...after];
	return `${merged.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
