function parseIso(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function durationMs(startIso: string | undefined, endIso?: string): number | null {
	const start = parseIso(startIso);
	if (start === null) return null;
	const end = endIso ? parseIso(endIso) : Date.now();
	if (end === null) return null;
	return Math.max(0, end - start);
}

export function formatDurationMs(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "0s";

	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) return `${hours}h${minutes}m`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

export function formatDuration(startIso: string | undefined, endIso?: string): string | null {
	const ms = durationMs(startIso, endIso);
	if (ms === null) return null;
	return formatDurationMs(ms);
}
