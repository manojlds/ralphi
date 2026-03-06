import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopRun } from "./types";

export type PendingStory = {
	id: string;
	title: string;
};

type StoryStatus = "open" | "in_progress" | "done" | "other";

type NormalizedStory = {
	id: string;
	title: string;
	priority: number;
	status: StoryStatus;
	done: boolean;
	dependencies: string[];
};

type ParsedStories = {
	parsed: Record<string, unknown>;
	stories: Record<string, unknown>[];
};

export function activeLoop(loops: ReadonlyMap<string, LoopRun>): LoopRun | undefined {
	return [...loops.values()].find((loop) => loop.active);
}

export function findLoop(loops: ReadonlyMap<string, LoopRun>, requested: string): LoopRun | undefined {
	if (requested.trim()) return loops.get(requested.trim());
	return activeLoop(loops);
}

export function sortedLoops(loops: ReadonlyMap<string, LoopRun>): LoopRun[] {
	return [...loops.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function loopOptionLabel(loop: LoopRun): string {
	const state = loop.active ? "active" : "inactive";
	const stopping = loop.stopRequested ? ", stopping" : "";
	return `${loop.id} — iter ${loop.iteration}/${loop.maxIterations} (${state}${stopping})`;
}

function parsePriority(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return Number.MAX_SAFE_INTEGER;
}

function parseStoryStatus(value: unknown): StoryStatus {
	if (typeof value !== "string") return "open";
	const normalized = value.trim().toLowerCase();
	if (normalized.length === 0) return "open";
	if (["done", "completed", "complete"].includes(normalized)) return "done";
	if (["in_progress", "in-progress", "started", "working"].includes(normalized)) return "in_progress";
	if (["open", "todo", "ready", "pending"].includes(normalized)) return "open";
	return "other";
}

function parseDependencyIds(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function parseStoriesContainer(raw: string): ParsedStories | null {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	if (!parsed || typeof parsed !== "object") return null;

	if (Array.isArray(parsed.userStories)) {
		return {
			parsed,
			stories: parsed.userStories.filter(
				(story): story is Record<string, unknown> => Boolean(story) && typeof story === "object",
			),
		};
	}

	return null;
}

function readStories(cwd: string, prdRelativePath: string): ParsedStories | null {
	const prdPath = path.join(cwd, prdRelativePath);
	if (!fs.existsSync(prdPath)) return null;
	try {
		return parseStoriesContainer(fs.readFileSync(prdPath, "utf8"));
	} catch {
		return null;
	}
}

function normalizeStories(stories: Record<string, unknown>[]): NormalizedStory[] {
	return stories
		.map((story) => {
			const id = typeof story.id === "string" ? story.id.trim() : "";
			const title = typeof story.title === "string" ? story.title.trim() : "";
			const status = parseStoryStatus(story.status);
			const dependencies = parseDependencyIds(story.dependsOn);
			return {
				id,
				title,
				priority: parsePriority(story.priority),
				status,
				done: status === "done",
				dependencies,
			};
		})
		.filter((story) => story.id.length > 0 && story.title.length > 0);
}

function compareStoryOrder(a: NormalizedStory, b: NormalizedStory): number {
	return a.priority - b.priority || a.id.localeCompare(b.id);
}

function pickNextPendingStory(stories: NormalizedStory[]): PendingStory | null {
	if (stories.length === 0) return null;
	const doneIds = new Set(stories.filter((story) => story.done).map((story) => story.id));
	const unblocked = stories.filter(
		(story) => !story.done && story.dependencies.every((dependencyId) => doneIds.has(dependencyId)),
	);
	if (unblocked.length === 0) return null;

	const open = unblocked.filter((story) => story.status === "open").sort(compareStoryOrder);
	if (open.length > 0) return { id: open[0].id, title: open[0].title };

	const inProgress = unblocked.filter((story) => story.status === "in_progress").sort(compareStoryOrder);
	if (inProgress.length > 0) return { id: inProgress[0].id, title: inProgress[0].title };

	const fallback = unblocked.sort(compareStoryOrder);
	if (fallback.length === 0) return null;
	return { id: fallback[0].id, title: fallback[0].title };
}

function truncateTitle(title: string, maxLength = 48): string {
	const compact = title.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, maxLength - 1)}…`;
}

export function nextPendingStory(cwd: string, prdRelativePath: string): PendingStory | null {
	const parsedStories = readStories(cwd, prdRelativePath);
	if (!parsedStories) return null;
	return pickNextPendingStory(normalizeStories(parsedStories.stories));
}

/**
 * Returns:
 * - true  => PRD exists and has at least one story not in done state
 * - false => PRD exists and all stories are done
 * - undefined => PRD missing/unreadable/invalid shape (unknown, keep loop behavior unchanged)
 */
export function hasRemainingPrdStories(cwd: string, prdRelativePath: string): boolean | undefined {
	const parsedStories = readStories(cwd, prdRelativePath);
	if (!parsedStories) return undefined;

	const stories = normalizeStories(parsedStories.stories);
	return stories.some((story) => !story.done);
}

function updatePrdStory(
	cwd: string,
	prdRelativePath: string,
	storyId: string,
	updater: (story: Record<string, unknown>, nowIso: string) => void,
): boolean {
	const prdPath = path.join(cwd, prdRelativePath);
	if (!fs.existsSync(prdPath)) return false;

	try {
		const raw = fs.readFileSync(prdPath, "utf8");
		const parsedStories = parseStoriesContainer(raw);
		if (!parsedStories) return false;

		const target = parsedStories.stories.find((story) => {
			const id = typeof story.id === "string" ? story.id.trim() : "";
			return id === storyId;
		});
		if (!target) return false;

		updater(target, new Date().toISOString());
		fs.writeFileSync(prdPath, `${JSON.stringify(parsedStories.parsed, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

export function markPrdStoryInProgress(cwd: string, prdRelativePath: string, storyId: string): boolean {
	return updatePrdStory(cwd, prdRelativePath, storyId, (story, nowIso) => {
		story.status = "in_progress";
		delete story.passes;
		if (typeof story.startedAt !== "string" || story.startedAt.trim().length === 0) {
			story.startedAt = nowIso;
		}
		story.updatedAt = nowIso;
		story.completedAt = null;
	});
}

export function markPrdStoryDone(cwd: string, prdRelativePath: string, storyId: string): boolean {
	return updatePrdStory(cwd, prdRelativePath, storyId, (story, nowIso) => {
		story.status = "done";
		delete story.passes;
		if (typeof story.startedAt !== "string" || story.startedAt.trim().length === 0) {
			story.startedAt = nowIso;
		}
		story.updatedAt = nowIso;
		story.completedAt = nowIso;
	});
}

export function buildIterationSessionName(loop: LoopRun, story: PendingStory | null): string {
	if (!story) return `ralphi loop ${loop.id} · iter ${loop.iteration}`;
	return `ralphi loop ${loop.id} · iter ${loop.iteration} · ${story.id} ${truncateTitle(story.title)}`;
}
