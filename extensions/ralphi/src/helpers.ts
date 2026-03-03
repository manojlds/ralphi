import * as fs from "node:fs";
import * as path from "node:path";

export function parseMaxIterations(args: string): number {
	const match = args.match(/--max-iterations\s+(\d+)/);
	if (!match) return 50;
	const parsed = Number.parseInt(match[1], 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return 50;
	return parsed;
}

export function renderOutputs(cwd: string, outputs: string[] | undefined): { lines: string[]; hasMissing: boolean } {
	if (!outputs || outputs.length === 0) {
		return { lines: ["- (none declared)"], hasMissing: false };
	}

	let hasMissing = false;
	const lines = outputs.map((out) => {
		const resolved = path.resolve(cwd, out);
		const exists = fs.existsSync(resolved);
		if (!exists) hasMissing = true;
		return `- [${exists ? "x" : " "}] ${out}`;
	});

	return { lines, hasMissing };
}
