import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

describe("US-001: ralphi-loop skill review protocol", () => {
	function readLoopSkill(): string {
		return fs.readFileSync(path.resolve(__dirname, "../../../skills/ralphi-loop/SKILL.md"), "utf8");
	}

	it("defines an explicit required post-implementation review protocol", () => {
		const skillContent = readLoopSkill();

		expect(skillContent).toContain("REQUIRED Post-Implementation Step-Back Review Protocol");
		expect(skillContent).toContain("Re-read the target story in `prd.json`");
		expect(skillContent).toContain("Re-read `## Codebase Patterns`");
		expect(skillContent).toContain("deterministic code review pass");
	});

	it("defines PRD trajectory states and drift handling", () => {
		const skillContent = readLoopSkill();

		expect(skillContent).toContain("ON_TRACK");
		expect(skillContent).toContain("RISK");
		expect(skillContent).toContain("DRIFT");
		expect(skillContent).toContain("If `DRIFT`, define a corrective plan");
	});

	it("documents progress log fields for review outcome and trajectory", () => {
		const skillContent = readLoopSkill();

		expect(skillContent).toContain("Review Outcome: [PASS | CHANGES_REQUIRED]");
		expect(skillContent).toContain("Trajectory: [ON_TRACK | RISK | DRIFT]");
		expect(skillContent).toContain("Trajectory Notes:");
		expect(skillContent).toContain("Corrective Plan:");
	});

	it("keeps the phase prompt/skill-driven without runtime command requirements", () => {
		const skillContent = readLoopSkill();

		expect(skillContent).toContain("prompt/skill-driven only");
		expect(skillContent).toContain("do not require runtime command/tool changes");
	});
});
