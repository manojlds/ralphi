import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("US-004: reflection cadence docs and migration guidance", () => {
	function readReadme(): string {
		return fs.readFileSync(path.resolve(__dirname, "../../../README.md"), "utf8");
	}

	function readChangelog(): string {
		return fs.readFileSync(path.resolve(__dirname, "../../../CHANGELOG.md"), "utf8");
	}

	it("documents loop.reflectEvery and loop.reflectInstructions usage in README", () => {
		const readme = readReadme();

		expect(readme).toContain("loop.reflectEvery");
		expect(readme).toContain("loop.reflectInstructions");
		expect(readme).toContain("Reflection checkpoints (opt-in, gradual rollout)");
		expect(readme).toContain("reflectEvery: 3");
	});

	it("documents default-off behavior and gradual rollout guidance in README", () => {
		const readme = readReadme();

		expect(readme).toContain("disabled by default");
		expect(readme).toContain("Suggested migration path");
		expect(readme).toContain("reflectEvery: 5");
		expect(readme).toContain("Tighten cadence");
	});

	it("includes release and migration notes for reflection checkpoints in changelog", () => {
		const changelog = readChangelog();

		expect(changelog).toContain("Release notes (reflection checkpoints documentation)");
		expect(changelog).toContain("Migration notes");
		expect(changelog).toContain("loop.reflectEvery");
		expect(changelog).toContain("opt-in");
	});
});
