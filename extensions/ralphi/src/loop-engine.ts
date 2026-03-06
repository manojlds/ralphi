import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopRun } from "./types";

export type PendingStory = {
	id: string;
	title: string;
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

function truncateTitle(title: string, maxLength = 48): string {
	const compact = title.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) return compact;
	return `${compact.slice(0, maxLength - 1)}…`;
}

export function nextPendingStory(cwd: string, prdRelativePath: string): PendingStory | null {
	const prdPath = path.join(cwd, prdRelativePath);
	if (!fs.existsSync(prdPath)) return null;

	try {
		const parsed = JSON.parse(fs.readFileSync(prdPath, "utf8")) as { userStories?: unknown };
		if (!parsed || !Array.isArray(parsed.userStories)) return null;

		const pending = parsed.userStories
			.filter((story): story is Record<string, unknown> => Boolean(story) && typeof story === "object")
			.filter((story) => story.passes !== true)
			.map((story) => ({
				id: typeof story.id === "string" ? story.id.trim() : "",
				title: typeof story.title === "string" ? story.title.trim() : "",
				priority: parsePriority(story.priority),
			}))
			.filter((story) => story.id.length > 0 && story.title.length > 0)
			.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

		if (pending.length === 0) return null;
		return { id: pending[0].id, title: pending[0].title };
	} catch {
		return null;
	}
}

/**
 * Returns:
 * - true  => PRD exists and has at least one story with passes !== true
 * - false => PRD exists and all stories are passes === true
 * - undefined => PRD missing/unreadable/invalid shape (unknown, keep loop behavior unchanged)
 */
export function hasRemainingPrdStories(cwd: string, prdRelativePath: string): boolean | undefined {
	const prdPath = path.join(cwd, prdRelativePath);
	if (!fs.existsSync(prdPath)) return undefined;

	try {
		const parsed = JSON.parse(fs.readFileSync(prdPath, "utf8")) as { userStories?: unknown };
		if (!parsed || !Array.isArray(parsed.userStories)) return undefined;

		return parsed.userStories
			.filter((story): story is Record<string, unknown> => Boolean(story) && typeof story === "object")
			.some((story) => story.passes !== true);
	} catch {
		return undefined;
	}
}

export function buildIterationSessionName(loop: LoopRun, story: PendingStory | null): string {
	if (!story) return `ralphi loop ${loop.id} · iter ${loop.iteration}`;
	return `ralphi loop ${loop.id} · iter ${loop.iteration} · ${story.id} ${truncateTitle(story.title)}`;
}
