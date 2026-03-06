import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("US-004: sequential rollout and release safety", () => {
	function readThreePhasePrd(): string {
		return fs.readFileSync(
			path.resolve(__dirname, "../../../tasks/prd-three-phase-loop-guidance-and-step-back-review.md"),
			"utf8",
		);
	}

	function readChangelog(): string {
		return fs.readFileSync(path.resolve(__dirname, "../../../CHANGELOG.md"), "utf8");
	}

	it("defines strict phase sequencing gates between phases", () => {
		const prd = readThreePhasePrd();

		expect(prd).toContain("Only after Phase 1 acceptance is complete");
		expect(prd).toContain("Only after Phase 2 acceptance is complete");
		expect(prd).toContain("Sequential enforcement policy");
		expect(prd).toContain("status: \"done\"` in `prd.json`");
	});

	it("documents explicit go/no-go and rollback expectations for each phase", () => {
		const prd = readThreePhasePrd();

		expect(prd).toContain("Go Criteria");
		expect(prd).toContain("No-Go Criteria");
		expect(prd).toContain("Rollback Expectations");
		expect(prd).toContain("Revert skill + test changes");
		expect(prd).toContain("Disable guidance injection + command wiring");
		expect(prd).toContain("Revert advanced-control enforcement");
	});

	it("defines release notes and migration notes for external behavior changes", () => {
		const prd = readThreePhasePrd();
		const changelog = readChangelog();

		expect(prd).toContain("Release Notes (Externally Visible Changes)");
		expect(prd).toContain("Migration Notes");
		expect(changelog).toContain("Release notes (three-phase loop guidance rollout)");
		expect(changelog).toContain("Migration notes");
	});
});
