import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerEvents } from "../src/events";
import { RalphiRuntime } from "../src/runtime";
import {
	buildConvertSummary,
	buildDeterministicSummary,
	buildInitSummary,
	buildPrdSummary,
	parseConfigYaml,
	parsePrdJson,
	parsePrdMarkdown,
} from "../src/summary";
import type { PhaseRun } from "../src/types";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager, createMockUi } from "./factories/pi";

// ---- Helpers ----

function makeRun(overrides: Partial<PhaseRun> & Pick<PhaseRun, "phase" | "cwd">): PhaseRun {
	return {
		id: "run-test1234",
		status: "awaiting_finalize",
		sessionKey: "session-test.json",
		checkpointLeafId: "leaf-1",
		createdAt: new Date().toISOString(),
		autoConfirm: false,
		...overrides,
	};
}

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-summary-"));
}

function writeFile(dir: string, relativePath: string, content: string) {
	const fullPath = path.join(dir, relativePath);
	fs.mkdirSync(path.dirname(fullPath), { recursive: true });
	fs.writeFileSync(fullPath, content);
}

const SAMPLE_CONFIG = `# ralphi ralph configuration
# Auto-generated — edit as needed

project:
  name: "my-app"
  language: "TypeScript"
  framework: "Next.js"

commands:
  test: "npm run test"
  lint: "npm run lint"
  build: "npm run build"
  typecheck: "npx tsc --noEmit"

rules:
  - "use vitest for testing"
  - "follow existing patterns in src/"
  - "use strict TypeScript"

boundaries:
  never_touch:
    - "*.lock"
    - ".env*"

engine: "pi"
max_retries: 3
`;

const SAMPLE_PRD_MD = `# Interactive Q&A Flow

## Introduction/Overview
Add structured questioning to init and prd phases.

## Goals
- Add interactive question flow for init and prd
- Support structured single-select and multi-select options
- Graceful fallback for non-UI environments

## User Stories

### US-001: Ask Tool Registration
**Description:** As an agent, I want a question tool so I can gather input.

**Acceptance Criteria:**
- [ ] Tool is registered
- [ ] Supports single and multi-select

### US-002: Phase-Scoped Availability
**Description:** As a maintainer, I want the tool only in init/prd.

**Acceptance Criteria:**
- [ ] Tool available in init and prd
- [ ] Not available in convert or loop

### US-003: Graceful Fallback
**Description:** As a user without UI, I want clear error messages.

**Acceptance Criteria:**
- [ ] Error message when no UI
`;

const SAMPLE_PRD_JSON = JSON.stringify(
	{
		project: "my-app",
		branchName: "ralph/interactive-qna",
		description: "Interactive Q&A for init and prd",
		userStories: [
			{ id: "US-001", title: "Ask Tool Registration", priority: 1, passes: true, notes: "" },
			{ id: "US-002", title: "Phase-Scoped Availability", priority: 2, passes: true, notes: "" },
			{ id: "US-003", title: "Graceful Fallback", priority: 3, passes: false, notes: "" },
		],
	},
	null,
	2,
);

// ---- Parser unit tests ----

describe("parseConfigYaml", () => {
	it("parses a complete config with all fields", () => {
		const result = parseConfigYaml(SAMPLE_CONFIG);

		expect(result.projectName).toBe("my-app");
		expect(result.language).toBe("TypeScript");
		expect(result.framework).toBe("Next.js");
		expect(result.engine).toBe("pi");
		expect(result.commands).toEqual({
			test: "npm run test",
			lint: "npm run lint",
			build: "npm run build",
			typecheck: "npx tsc --noEmit",
		});
		expect(result.rules).toEqual([
			"use vitest for testing",
			"follow existing patterns in src/",
			"use strict TypeScript",
		]);
	});

	it("handles missing optional fields", () => {
		const config = `project:
  name: "simple"
  language: "Go"

commands:
  test: "go test ./..."

engine: "amp"
`;
		const result = parseConfigYaml(config);

		expect(result.projectName).toBe("simple");
		expect(result.language).toBe("Go");
		expect(result.framework).toBeUndefined();
		expect(result.engine).toBe("amp");
		expect(result.commands).toEqual({ test: "go test ./..." });
		expect(result.rules).toEqual([]);
	});

	it("handles empty content", () => {
		const result = parseConfigYaml("");

		expect(result.projectName).toBeUndefined();
		expect(result.commands).toEqual({});
		expect(result.rules).toEqual([]);
	});

	it("handles comments-only content", () => {
		const result = parseConfigYaml("# just a comment\n# another comment\n");

		expect(result.projectName).toBeUndefined();
		expect(result.commands).toEqual({});
	});

	it("ignores nested sections it does not handle (boundaries)", () => {
		const config = `boundaries:
  never_touch:
    - "*.lock"
    - ".env*"

rules:
  - "real rule"
`;
		const result = parseConfigYaml(config);

		expect(result.rules).toEqual(["real rule"]);
	});

	it("handles unquoted values", () => {
		const config = `project:
  name: unquoted-name
  language: Python

engine: claude
`;
		const result = parseConfigYaml(config);

		expect(result.projectName).toBe("unquoted-name");
		expect(result.language).toBe("Python");
		expect(result.engine).toBe("claude");
	});

	it("handles single-quoted values", () => {
		const config = `project:
  name: 'single-quoted'

engine: 'amp'
`;
		const result = parseConfigYaml(config);

		expect(result.projectName).toBe("single-quoted");
		expect(result.engine).toBe("amp");
	});

	it("handles Windows line endings", () => {
		const config = "project:\r\n  name: \"win-app\"\r\n\r\nengine: \"pi\"\r\n";
		const result = parseConfigYaml(config);

		expect(result.projectName).toBe("win-app");
		expect(result.engine).toBe("pi");
	});
});

describe("parsePrdMarkdown", () => {
	it("extracts title, goals, and stories from a well-formed PRD", () => {
		const result = parsePrdMarkdown(SAMPLE_PRD_MD);

		expect(result.title).toBe("Interactive Q&A Flow");
		expect(result.goals).toEqual([
			"Add interactive question flow for init and prd",
			"Support structured single-select and multi-select options",
			"Graceful fallback for non-UI environments",
		]);
		expect(result.stories).toEqual([
			{ id: "US-001", title: "Ask Tool Registration" },
			{ id: "US-002", title: "Phase-Scoped Availability" },
			{ id: "US-003", title: "Graceful Fallback" },
		]);
	});

	it("handles PRD with no goals section", () => {
		const prd = `# Feature

## User Stories

### US-001: Only Story
Just a story.
`;
		const result = parsePrdMarkdown(prd);

		expect(result.title).toBe("Feature");
		expect(result.goals).toEqual([]);
		expect(result.stories).toEqual([{ id: "US-001", title: "Only Story" }]);
	});

	it("handles PRD with no user stories", () => {
		const prd = `# Feature

## Goals
- One goal
- Two goals
`;
		const result = parsePrdMarkdown(prd);

		expect(result.goals).toEqual(["One goal", "Two goals"]);
		expect(result.stories).toEqual([]);
	});

	it("handles empty content", () => {
		const result = parsePrdMarkdown("");

		expect(result.title).toBeUndefined();
		expect(result.goals).toEqual([]);
		expect(result.stories).toEqual([]);
	});

	it("handles goals with asterisk bullets", () => {
		const prd = `## Goals
* First goal
* Second goal
`;
		const result = parsePrdMarkdown(prd);

		expect(result.goals).toEqual(["First goal", "Second goal"]);
	});
});

describe("parsePrdJson", () => {
	it("parses valid prd.json content", () => {
		const result = parsePrdJson(SAMPLE_PRD_JSON);

		expect(result).not.toBeNull();
		expect(result!.project).toBe("my-app");
		expect(result!.branchName).toBe("ralph/interactive-qna");
		expect(result!.stories).toHaveLength(3);
		expect(result!.stories[0]).toEqual({
			id: "US-001",
			title: "Ask Tool Registration",
			priority: 1,
			passes: true,
		});
		expect(result!.stories[2].passes).toBe(false);
	});

	it("returns null for invalid JSON", () => {
		expect(parsePrdJson("not json")).toBeNull();
	});

	it("returns null for non-object JSON", () => {
		expect(parsePrdJson('"just a string"')).toBeNull();
		expect(parsePrdJson("42")).toBeNull();
	});

	it("handles missing optional fields", () => {
		const result = parsePrdJson(JSON.stringify({ userStories: [] }));

		expect(result).not.toBeNull();
		expect(result!.project).toBeUndefined();
		expect(result!.branchName).toBeUndefined();
		expect(result!.stories).toEqual([]);
	});

	it("defaults priority to 999 for non-numeric values", () => {
		const result = parsePrdJson(
			JSON.stringify({
				userStories: [{ id: "US-001", title: "Story", passes: false }],
			}),
		);

		expect(result!.stories[0].priority).toBe(999);
	});

	it("treats non-true passes as false", () => {
		const result = parsePrdJson(
			JSON.stringify({
				userStories: [
					{ id: "US-001", title: "A", passes: "yes" },
					{ id: "US-002", title: "B", passes: null },
					{ id: "US-003", title: "C" },
				],
			}),
		);

		expect(result!.stories.every((s) => s.passes === false)).toBe(true);
	});
});

// ---- Summary builder tests (with temp dirs for file I/O) ----

describe("buildInitSummary", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds full summary with config.yaml present", () => {
		writeFile(tempDir, ".ralphi/config.yaml", SAMPLE_CONFIG);
		writeFile(tempDir, "AGENTS.md", "# agents");

		const run = makeRun({
			phase: "ralphi-init",
			cwd: tempDir,
			summary: "Scanned project and generated configuration.",
			outputs: [".ralphi/config.yaml", "AGENTS.md"],
		});

		const summary = buildInitSummary(run);

		expect(summary).toContain("[RALPHI INIT COMPLETE]");
		expect(summary).toContain("Run: run-test1234");
		expect(summary).toContain("Project: my-app");
		expect(summary).toContain("Language: TypeScript");
		expect(summary).toContain("Framework: Next.js");
		expect(summary).toContain("Engine: pi");
		expect(summary).toContain("test: npm run test");
		expect(summary).toContain("lint: npm run lint");
		expect(summary).toContain("- use vitest for testing");
		expect(summary).toContain("✓ .ralphi/config.yaml");
		expect(summary).toContain("✓ AGENTS.md");
		expect(summary).toContain("Summary: Scanned project and generated configuration.");
	});

	it("falls back to just outputs + summary when config.yaml is missing", () => {
		const run = makeRun({
			phase: "ralphi-init",
			cwd: tempDir,
			summary: "Init completed.",
			outputs: [".ralphi/config.yaml"],
		});

		const summary = buildInitSummary(run);

		expect(summary).toContain("[RALPHI INIT COMPLETE]");
		expect(summary).toContain("Run: run-test1234");
		expect(summary).not.toContain("Project:");
		expect(summary).not.toContain("Language:");
		expect(summary).toContain("✗ .ralphi/config.yaml");
		expect(summary).toContain("Summary: Init completed.");
	});

	it("handles partial config (no framework)", () => {
		writeFile(
			tempDir,
			".ralphi/config.yaml",
			`project:
  name: "simple"
  language: "Go"

commands:
  test: "go test ./..."

engine: "amp"
`,
		);

		const run = makeRun({
			phase: "ralphi-init",
			cwd: tempDir,
			summary: "Init done.",
		});

		const summary = buildInitSummary(run);

		expect(summary).toContain("Project: simple");
		expect(summary).toContain("Language: Go");
		expect(summary).not.toContain("Framework:");
		expect(summary).toContain("Engine: amp");
		expect(summary).toContain("test: go test ./...");
	});

	it("shows no outputs section when outputs array is empty", () => {
		const run = makeRun({
			phase: "ralphi-init",
			cwd: tempDir,
			outputs: [],
		});

		const summary = buildInitSummary(run);

		expect(summary).not.toContain("Files created/updated:");
	});
});

describe("buildPrdSummary", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds full summary with PRD markdown present", () => {
		writeFile(tempDir, "tasks/prd-interactive-qna.md", SAMPLE_PRD_MD);

		const run = makeRun({
			phase: "ralphi-prd",
			cwd: tempDir,
			summary: "Generated PRD with 3 user stories.",
			outputs: ["tasks/prd-interactive-qna.md"],
		});

		const summary = buildPrdSummary(run);

		expect(summary).toContain("[RALPHI PRD COMPLETE]");
		expect(summary).toContain("PRD: tasks/prd-interactive-qna.md");
		expect(summary).toContain("Feature: Interactive Q&A Flow");
		expect(summary).toContain("- Add interactive question flow for init and prd");
		expect(summary).toContain("User Stories (3):");
		expect(summary).toContain("US-001: Ask Tool Registration");
		expect(summary).toContain("US-002: Phase-Scoped Availability");
		expect(summary).toContain("US-003: Graceful Fallback");
		expect(summary).toContain("✓ tasks/prd-interactive-qna.md");
		expect(summary).toContain("Summary: Generated PRD with 3 user stories.");
	});

	it("falls back when PRD file does not exist", () => {
		const run = makeRun({
			phase: "ralphi-prd",
			cwd: tempDir,
			summary: "Created PRD.",
			outputs: ["tasks/prd-missing.md"],
		});

		const summary = buildPrdSummary(run);

		expect(summary).toContain("[RALPHI PRD COMPLETE]");
		expect(summary).toContain("PRD: tasks/prd-missing.md");
		expect(summary).not.toContain("Feature:");
		expect(summary).not.toContain("Goals:");
		expect(summary).toContain("✗ tasks/prd-missing.md");
		expect(summary).toContain("Summary: Created PRD.");
	});

	it("handles run with no outputs", () => {
		const run = makeRun({
			phase: "ralphi-prd",
			cwd: tempDir,
			summary: "PRD generated.",
		});

		const summary = buildPrdSummary(run);

		expect(summary).toContain("[RALPHI PRD COMPLETE]");
		expect(summary).not.toContain("PRD:");
		expect(summary).not.toContain("Files created/updated:");
		expect(summary).toContain("Summary: PRD generated.");
	});

	it("detects PRD files using the prd- naming convention", () => {
		writeFile(tempDir, "tasks/prd-auth-feature.md", "# Auth Feature\n\n## Goals\n- Secure login\n");

		const run = makeRun({
			phase: "ralphi-prd",
			cwd: tempDir,
			outputs: ["tasks/prd-auth-feature.md"],
		});

		const summary = buildPrdSummary(run);

		expect(summary).toContain("PRD: tasks/prd-auth-feature.md");
		expect(summary).toContain("Feature: Auth Feature");
		expect(summary).toContain("- Secure login");
	});
});

describe("buildConvertSummary", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds full summary with prd.json present", () => {
		writeFile(tempDir, "prd.json", SAMPLE_PRD_JSON);

		const run = makeRun({
			phase: "ralphi-convert",
			cwd: tempDir,
			summary: "Converted PRD to prd.json with 3 stories.",
			outputs: ["prd.json"],
		});

		const summary = buildConvertSummary(run);

		expect(summary).toContain("[RALPHI CONVERT COMPLETE]");
		expect(summary).toContain("Project: my-app");
		expect(summary).toContain("Branch: ralph/interactive-qna");
		expect(summary).toContain("Stories (3):");
		expect(summary).toContain("US-001: Ask Tool Registration");
		expect(summary).toContain("US-002: Phase-Scoped Availability");
		expect(summary).toContain("US-003: Graceful Fallback");
		expect(summary).not.toMatch(/\[\d+\]/); // no priority numbers
		expect(summary).toContain("✓ prd.json");
		expect(summary).toContain("Summary: Converted PRD to prd.json with 3 stories.");
	});

	it("lists stories in their original order without priority sorting", () => {
		const prd = JSON.stringify({
			project: "test",
			branchName: "ralph/test",
			userStories: [
				{ id: "US-003", title: "Third defined", priority: 3, passes: false },
				{ id: "US-001", title: "First defined", priority: 1, passes: false },
				{ id: "US-002", title: "Second defined", priority: 2, passes: false },
			],
		});
		writeFile(tempDir, "prd.json", prd);

		const run = makeRun({
			phase: "ralphi-convert",
			cwd: tempDir,
			outputs: ["prd.json"],
		});

		const summary = buildConvertSummary(run);
		const lines = summary.split("\n");
		const storyLines = lines.filter((l) => l.match(/^\s+US-\d+:/));

		expect(storyLines[0]).toContain("US-003: Third defined");
		expect(storyLines[1]).toContain("US-001: First defined");
		expect(storyLines[2]).toContain("US-002: Second defined");
	});

	it("falls back when prd.json does not exist", () => {
		const run = makeRun({
			phase: "ralphi-convert",
			cwd: tempDir,
			summary: "Conversion done.",
			outputs: ["prd.json"],
		});

		const summary = buildConvertSummary(run);

		expect(summary).toContain("[RALPHI CONVERT COMPLETE]");
		expect(summary).not.toContain("Project:");
		expect(summary).not.toContain("Branch:");
		expect(summary).toContain("✗ prd.json");
		expect(summary).toContain("Summary: Conversion done.");
	});
});

describe("buildDeterministicSummary", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("dispatches to buildInitSummary for ralphi-init", () => {
		const run = makeRun({ phase: "ralphi-init", cwd: tempDir, summary: "init" });
		const summary = buildDeterministicSummary(run);
		expect(summary).toContain("[RALPHI INIT COMPLETE]");
	});

	it("dispatches to buildPrdSummary for ralphi-prd", () => {
		const run = makeRun({ phase: "ralphi-prd", cwd: tempDir, summary: "prd" });
		const summary = buildDeterministicSummary(run);
		expect(summary).toContain("[RALPHI PRD COMPLETE]");
	});

	it("dispatches to buildConvertSummary for ralphi-convert", () => {
		const run = makeRun({ phase: "ralphi-convert", cwd: tempDir, summary: "convert" });
		const summary = buildDeterministicSummary(run);
		expect(summary).toContain("[RALPHI CONVERT COMPLETE]");
	});

	it("returns undefined for ralphi-loop-iteration (finalized via session switch, not tree)", () => {
		const run = makeRun({ phase: "ralphi-loop-iteration", cwd: tempDir, summary: "loop" });
		const summary = buildDeterministicSummary(run);
		expect(summary).toBeUndefined();
	});
});

// ---- Runtime integration: handleBeforeTree ----

describe("handleBeforeTree integration", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function extractRunId(messages: Array<{ text: string }>): string {
		const kickoff = messages.find((m) => m.text.includes("runId:"));
		const match = kickoff?.text.match(/runId:\s*"?([^"\s\n]+)"?/);
		if (!match) throw new Error("runId not found in messages");
		return match[1];
	}

	it("provides a deterministic summary during finalize instead of LLM summarization", async () => {
		writeFile(
			tempDir,
			".ralphi/config.yaml",
			`project:
  name: "test-project"
  language: "TypeScript"

commands:
  test: "npm test"

engine: "pi"
`,
		);
		writeFile(tempDir, "AGENTS.md", "# agents");

		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		// Capture the session_before_tree handler
		const beforeTreeHandlers = api.registeredEvents.get("session_before_tree") ?? [];
		expect(beforeTreeHandlers).toHaveLength(1);

		// Wire navigateTree to fire the event
		let capturedSummary: { summary: { summary: string; details: unknown } } | undefined;
		const ctx = createMockCommandContext({
			sessionManager,
			cwd: tempDir,
			navigateCancelled: false,
		});
		const origNavigateTree = ctx.navigateTree.bind(ctx);
		ctx.navigateTree = async (leafId: string, options?: Record<string, unknown>) => {
			// Fire session_before_tree like pi would
			for (const handler of beforeTreeHandlers) {
				const result = await (handler as any)(
					{ preparation: { targetId: leafId, entriesToSummarize: [], userWantsSummary: true } },
					{ cwd: tempDir, hasUI: true, sessionManager, ui: createMockUi(), isIdle: () => true },
				);
				if (result?.summary) {
					capturedSummary = result;
				}
			}
			return origNavigateTree(leafId, options);
		};

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		const done = await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "Initialized project configuration.",
			outputs: [".ralphi/config.yaml", "AGENTS.md"],
		});
		expect(done.ok).toBe(true);

		// Trigger finalize via turn_end
		await runtime.handleTurnEnd(ctx as any);

		// Verify the deterministic summary was provided
		expect(capturedSummary).toBeDefined();
		expect(capturedSummary!.summary.summary).toContain("[RALPHI INIT COMPLETE]");
		expect(capturedSummary!.summary.summary).toContain("Project: test-project");
		expect(capturedSummary!.summary.summary).toContain("Language: TypeScript");
		expect(capturedSummary!.summary.summary).toContain("Engine: pi");
		expect(capturedSummary!.summary.summary).toContain("test: npm test");
		expect(capturedSummary!.summary.summary).toContain("Summary: Initialized project configuration.");
		expect(capturedSummary!.summary.details).toEqual({ phase: "ralphi-init", runId });
	});

	it("returns undefined when no run is being finalized", () => {
		const api = createMockExtensionApi(createMockSessionManager());
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeTreeHandlers = api.registeredEvents.get("session_before_tree") ?? [];
		expect(beforeTreeHandlers).toHaveLength(1);

		const result = (beforeTreeHandlers[0] as any)(
			{ preparation: { targetId: "random-leaf" } },
			{},
		);

		expect(result).toBeUndefined();
	});

	it("returns undefined when targetId does not match the checkpoint", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeTreeHandlers = api.registeredEvents.get("session_before_tree") ?? [];

		// Wire navigateTree to fire the event with a DIFFERENT targetId
		let capturedResult: unknown;
		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });
		const origNavigateTree = ctx.navigateTree.bind(ctx);
		ctx.navigateTree = async (leafId: string, options?: Record<string, unknown>) => {
			// Fire event with a non-matching targetId
			for (const handler of beforeTreeHandlers) {
				capturedResult = await (handler as any)(
					{ preparation: { targetId: "wrong-id" } },
					{},
				);
			}
			return origNavigateTree(leafId, options);
		};

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "done",
			outputs: [],
		});

		await runtime.handleTurnEnd(ctx as any);

		// The event was called but with wrong targetId — should return undefined
		expect(capturedResult).toBeUndefined();
	});

	it("clears the finalization tracking after navigateTree completes", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeTreeHandlers = api.registeredEvents.get("session_before_tree") ?? [];
		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "done",
			outputs: [],
		});

		await runtime.handleTurnEnd(ctx as any);

		// After finalize completes, handleBeforeTree should return undefined
		const result = (beforeTreeHandlers[0] as any)(
			{ preparation: { targetId: "any-id" } },
			{},
		);
		expect(result).toBeUndefined();
	});

	it("provides deterministic summary for ralphi-prd phase", async () => {
		writeFile(tempDir, "tasks/prd-feature.md", SAMPLE_PRD_MD);

		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeTreeHandlers = api.registeredEvents.get("session_before_tree") ?? [];
		let capturedSummary: { summary: { summary: string; details: unknown } } | undefined;
		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });
		const origNavigateTree = ctx.navigateTree.bind(ctx);
		ctx.navigateTree = async (leafId: string, options?: Record<string, unknown>) => {
			for (const handler of beforeTreeHandlers) {
				const result = await (handler as any)(
					{ preparation: { targetId: leafId } },
					{},
				);
				if (result?.summary) capturedSummary = result;
			}
			return origNavigateTree(leafId, options);
		};

		await runtime.startPhase(ctx as any, "ralphi-prd", "feature auth");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-prd",
			summary: "Generated PRD with 3 stories.",
			outputs: ["tasks/prd-feature.md"],
		});

		await runtime.handleTurnEnd(ctx as any);

		expect(capturedSummary).toBeDefined();
		expect(capturedSummary!.summary.summary).toContain("[RALPHI PRD COMPLETE]");
		expect(capturedSummary!.summary.summary).toContain("Feature: Interactive Q&A Flow");
		expect(capturedSummary!.summary.summary).toContain("User Stories (3):");
		expect(capturedSummary!.summary.details).toEqual({ phase: "ralphi-prd", runId });
	});

	it("provides deterministic summary for ralphi-convert phase", async () => {
		writeFile(tempDir, "prd.json", SAMPLE_PRD_JSON);

		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeTreeHandlers = api.registeredEvents.get("session_before_tree") ?? [];
		let capturedSummary: { summary: { summary: string; details: unknown } } | undefined;
		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });
		const origNavigateTree = ctx.navigateTree.bind(ctx);
		ctx.navigateTree = async (leafId: string, options?: Record<string, unknown>) => {
			for (const handler of beforeTreeHandlers) {
				const result = await (handler as any)(
					{ preparation: { targetId: leafId } },
					{},
				);
				if (result?.summary) capturedSummary = result;
			}
			return origNavigateTree(leafId, options);
		};

		await runtime.startPhase(ctx as any, "ralphi-convert", "tasks/prd-feature.md");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-convert",
			summary: "Converted PRD with 3 stories.",
			outputs: ["prd.json"],
		});

		await runtime.handleTurnEnd(ctx as any);

		expect(capturedSummary).toBeDefined();
		expect(capturedSummary!.summary.summary).toContain("[RALPHI CONVERT COMPLETE]");
		expect(capturedSummary!.summary.summary).toContain("Project: my-app");
		expect(capturedSummary!.summary.summary).toContain("Branch: ralph/interactive-qna");
		expect(capturedSummary!.summary.summary).toContain("Stories (3):");
		expect(capturedSummary!.summary.details).toEqual({ phase: "ralphi-convert", runId });
	});

	it("clears tracking even if navigateTree throws", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeTreeHandlers = api.registeredEvents.get("session_before_tree") ?? [];
		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });
		ctx.navigateTree = async () => {
			throw new Error("navigateTree exploded");
		};

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "done",
			outputs: [],
		});

		// handleTurnEnd will propagate the navigateTree error
		await runtime.handleTurnEnd(ctx as any).catch(() => {});

		// Even after an error, the tracking should be cleared
		const result = (beforeTreeHandlers[0] as any)(
			{ preparation: { targetId: "any-id" } },
			{},
		);
		expect(result).toBeUndefined();
	});
});

// ---- Runtime integration: handleBeforeCompact ----

describe("handleBeforeCompact integration", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function extractRunId(messages: Array<{ text: string }>): string {
		const kickoff = messages.find((m) => m.text.includes("runId:"));
		const match = kickoff?.text.match(/runId:\s*"?([^"\s\n]+)"?/);
		if (!match) throw new Error("runId not found in messages");
		return match[1];
	}

	it("cancels the first compaction after a successful tree collapse", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeCompactHandlers = api.registeredEvents.get("session_before_compact") ?? [];
		expect(beforeCompactHandlers).toHaveLength(1);

		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "done",
			outputs: [],
		});

		// Finalize — navigateTree creates a new summary entry
		await runtime.handleTurnEnd(ctx as any);

		// Simulate Pi firing session_before_compact right after collapse
		const compactResult = (beforeCompactHandlers[0] as any)(
			{ branchEntries: [{ id: "any-entry" }] },
			{},
		);

		expect(compactResult).toEqual({ cancel: true });
	});

	it("allows compaction on the second attempt (one-shot cancel)", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeCompactHandlers = api.registeredEvents.get("session_before_compact") ?? [];
		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "done",
			outputs: [],
		});

		await runtime.handleTurnEnd(ctx as any);

		// First compact — cancelled
		const result1 = (beforeCompactHandlers[0] as any)(
			{ branchEntries: [{ id: "entry-1" }] },
			{},
		);
		expect(result1).toEqual({ cancel: true });

		// Second compact — allowed (flag was cleared)
		const result2 = (beforeCompactHandlers[0] as any)(
			{ branchEntries: [{ id: "entry-1" }] },
			{},
		);
		expect(result2).toBeUndefined();
	});

	it("does not cancel compaction when no collapse happened", () => {
		const api = createMockExtensionApi(createMockSessionManager());
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeCompactHandlers = api.registeredEvents.get("session_before_compact") ?? [];

		const result = (beforeCompactHandlers[0] as any)(
			{ branchEntries: [{ id: "some-entry" }] },
			{},
		);

		expect(result).toBeUndefined();
	});

	it("does not cancel compaction when no collapse happened", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeCompactHandlers = api.registeredEvents.get("session_before_compact") ?? [];

		// No phase was run, so no collapse happened — flag is false
		const result = (beforeCompactHandlers[0] as any)(
			{ branchEntries: [{ id: "different-entry" }] },
			{},
		);

		expect(result).toBeUndefined();
	});

	it("does not cancel compaction when navigateTree was cancelled", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const beforeCompactHandlers = api.registeredEvents.get("session_before_compact") ?? [];
		const ctx = createMockCommandContext({
			sessionManager,
			cwd: tempDir,
			navigateCancelled: true,
		});

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "done",
			outputs: [],
		});

		await runtime.handleTurnEnd(ctx as any);

		// navigateTree was cancelled, so no collapsed leaf was recorded
		const result = (beforeCompactHandlers[0] as any)(
			{ branchEntries: [{ id: "any-entry" }] },
			{},
		);

		expect(result).toBeUndefined();
	});
});

// ---- Global collapse flag ----

describe("__ralphiCollapseInProgress flag", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
		globalThis.__ralphiCollapseInProgress = undefined;
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
		globalThis.__ralphiCollapseInProgress = undefined;
	});

	function extractRunId(messages: Array<{ text: string }>): string {
		const kickoff = messages.find((m) => m.text.includes("runId:"));
		const match = kickoff?.text.match(/runId:\s*"?([^"\s\n]+)"?/);
		if (!match) throw new Error("runId not found in messages");
		return match[1];
	}

	it("is true during navigateTree and false after", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		let flagDuringNavigate: boolean | undefined;
		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });
		const origNavigateTree = ctx.navigateTree.bind(ctx);
		ctx.navigateTree = async (leafId: string, options?: Record<string, unknown>) => {
			flagDuringNavigate = globalThis.__ralphiCollapseInProgress;
			return origNavigateTree(leafId, options);
		};

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "done",
			outputs: [],
		});

		await runtime.handleTurnEnd(ctx as any);

		expect(flagDuringNavigate).toBe(true);
		expect(globalThis.__ralphiCollapseInProgress).toBe(false);
	});

	it("is cleared even if navigateTree throws", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		registerEvents(api as any, runtime);

		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });
		ctx.navigateTree = async () => {
			throw new Error("boom");
		};

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "done",
			outputs: [],
		});

		await runtime.handleTurnEnd(ctx as any).catch(() => {});

		expect(globalThis.__ralphiCollapseInProgress).toBe(false);
	});
});

// ---- branchWithSummary fallback ----

describe("branchWithSummary fallback when commandContext is missing", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = makeTempDir();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function extractRunId(messages: Array<{ text: string }>): string {
		const kickoff = messages.find((m) => m.text.includes("runId:"));
		const match = kickoff?.text.match(/runId:\s*"?([^"\s\n]+)"?/);
		if (!match) throw new Error("runId not found in messages");
		return match[1];
	}

	it("uses branchWithSummary when commandContext is unavailable", async () => {
		// Phase 1: start + mark done with runtime A (has commandContext)
		const sessionManager = createMockSessionManager();
		const api1 = createMockExtensionApi(sessionManager);
		const runtime1 = new RalphiRuntime(api1 as any);
		const ctx1 = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime1.startPhase(ctx1 as any, "ralphi-init", "");
		const runId = extractRunId(api1.sendUserMessages);

		await runtime1.markPhaseDone(ctx1 as any, {
			runId,
			phase: "ralphi-init",
			summary: "Initialized project",
			outputs: [".ralphi/config.yaml"],
		});

		// Phase 2: simulate restart — new runtime loads persisted state
		// but has no commandContextByRun entries
		const api2 = createMockExtensionApi(sessionManager);
		const runtime2 = new RalphiRuntime(api2 as any);

		// Manually add the runId to pendingFinalizeRuns (simulating what
		// would happen if state was restored from disk with awaiting_finalize)
		(runtime2 as any).pendingFinalizeRuns.add(runId);

		// Create a turn_end context (ExtensionContext, not CommandContext)
		const turnEndCtx = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime2.handleTurnEnd(turnEndCtx as any);

		// branchWithSummary should have been called
		expect(sessionManager.branchWithSummaryCalls).toHaveLength(1);
		const call = sessionManager.branchWithSummaryCalls[0];
		expect(call.branchFromId).toBeTruthy();
		expect(call.summary).toContain("RALPHI INIT COMPLETE");
		expect(call.details).toEqual(expect.objectContaining({
			runId,
			phase: "ralphi-init",
			fallback: true,
		}));
		expect(call.fromHook).toBe(true);

		// Notification should mention fallback
		expect(turnEndCtx.ui.notifications.some(
			(n: { message: string; level: string }) =>
				n.message.includes("fallback") && n.message.includes(runId),
		)).toBe(true);
	});

	it("marks run as completed after fallback finalization", async () => {
		const sessionManager = createMockSessionManager();
		const api1 = createMockExtensionApi(sessionManager);
		const runtime1 = new RalphiRuntime(api1 as any);
		const ctx1 = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime1.startPhase(ctx1 as any, "ralphi-init", "");
		const runId = extractRunId(api1.sendUserMessages);

		await runtime1.markPhaseDone(ctx1 as any, {
			runId,
			phase: "ralphi-init",
			summary: "Done",
			outputs: [],
		});

		// New runtime without commandContext
		const api2 = createMockExtensionApi(sessionManager);
		const runtime2 = new RalphiRuntime(api2 as any);
		(runtime2 as any).pendingFinalizeRuns.add(runId);

		const turnEndCtx = createMockCommandContext({ sessionManager, cwd: tempDir });
		await runtime2.handleTurnEnd(turnEndCtx as any);

		// Run should be completed — verify via the ralphi-event entry
		const events = sessionManager.getEntries().filter(
			(e: any) => e.customType === "ralphi-event" && e.data?.kind === "phase_finalized",
		);
		const finalizedEvent = events.find((e: any) => e.data?.runId === runId);
		expect(finalizedEvent).toBeTruthy();
		expect((finalizedEvent as any).data.fallback).toBe(true);
	});

	it("uses deterministic summary from config.yaml when available", async () => {
		const sessionManager = createMockSessionManager();
		const api1 = createMockExtensionApi(sessionManager);
		const runtime1 = new RalphiRuntime(api1 as any);
		const ctx1 = createMockCommandContext({ sessionManager, cwd: tempDir });

		// Create a config.yaml so the deterministic summary is enriched
		const ralphiDir = path.join(tempDir, ".ralphi");
		fs.mkdirSync(ralphiDir, { recursive: true });
		fs.writeFileSync(
			path.join(ralphiDir, "config.yaml"),
			"project:\n  name: \"MyApp\"\n  language: \"TypeScript\"\n  framework: \"Next.js\"\n",
		);

		await runtime1.startPhase(ctx1 as any, "ralphi-init", "");
		const runId = extractRunId(api1.sendUserMessages);

		await runtime1.markPhaseDone(ctx1 as any, {
			runId,
			phase: "ralphi-init",
			summary: "Initialized MyApp",
			outputs: [".ralphi/config.yaml"],
		});

		// New runtime without commandContext
		const api2 = createMockExtensionApi(sessionManager);
		const runtime2 = new RalphiRuntime(api2 as any);
		(runtime2 as any).pendingFinalizeRuns.add(runId);

		const turnEndCtx = createMockCommandContext({ sessionManager, cwd: tempDir });
		await runtime2.handleTurnEnd(turnEndCtx as any);

		// The summary should include config details
		const call = sessionManager.branchWithSummaryCalls[0];
		expect(call.summary).toContain("MyApp");
		expect(call.summary).toContain("TypeScript");
		expect(call.summary).toContain("Next.js");
	});

	it("falls back to run.summary when deterministic summary is unavailable", async () => {
		const sessionManager = createMockSessionManager();
		const api1 = createMockExtensionApi(sessionManager);
		const runtime1 = new RalphiRuntime(api1 as any);
		const ctx1 = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime1.startPhase(ctx1 as any, "ralphi-init", "");
		const runId = extractRunId(api1.sendUserMessages);

		await runtime1.markPhaseDone(ctx1 as any, {
			runId,
			phase: "ralphi-init",
			summary: "Agent-provided summary text",
			outputs: [],
		});

		// No config.yaml exists, so buildDeterministicSummary will produce
		// a summary based on run.summary + run.outputs (no enrichment).
		// The deterministic builder still returns a string (just less enriched).
		const api2 = createMockExtensionApi(sessionManager);
		const runtime2 = new RalphiRuntime(api2 as any);
		(runtime2 as any).pendingFinalizeRuns.add(runId);

		const turnEndCtx = createMockCommandContext({ sessionManager, cwd: tempDir });
		await runtime2.handleTurnEnd(turnEndCtx as any);

		const call = sessionManager.branchWithSummaryCalls[0];
		expect(call.summary).toContain("Agent-provided summary text");
	});

	it("falls back to manual finalize when checkpointLeafId is null", async () => {
		const sessionManager = createMockSessionManager();
		const api1 = createMockExtensionApi(sessionManager);
		const runtime1 = new RalphiRuntime(api1 as any);
		const ctx1 = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime1.startPhase(ctx1 as any, "ralphi-init", "");
		const runId = extractRunId(api1.sendUserMessages);

		await runtime1.markPhaseDone(ctx1 as any, {
			runId,
			phase: "ralphi-init",
			summary: "Done",
			outputs: [],
		});

		// Corrupt the run to have no checkpointLeafId
		const run = (runtime1 as any).phaseRuns.get(runId);
		run.checkpointLeafId = null;
		(runtime1 as any).persistState(ctx1);

		// New runtime, no commandContext, no checkpoint
		const api2 = createMockExtensionApi(sessionManager);
		const runtime2 = new RalphiRuntime(api2 as any);
		(runtime2 as any).pendingFinalizeRuns.add(runId);

		const turnEndCtx = createMockCommandContext({ sessionManager, cwd: tempDir });
		await runtime2.handleTurnEnd(turnEndCtx as any);

		// branchWithSummary should NOT be called
		expect(sessionManager.branchWithSummaryCalls).toHaveLength(0);
		// Should fall back to manual finalize prompt
		expect(turnEndCtx.ui.notifications.some(
			(n: { message: string; level: string }) =>
				n.level === "warning" && n.message.includes("ralphi-finalize"),
		)).toBe(true);
	});

	it("falls back to manual finalize when branchWithSummary is not available", async () => {
		const sessionManager = createMockSessionManager();
		const api1 = createMockExtensionApi(sessionManager);
		const runtime1 = new RalphiRuntime(api1 as any);
		const ctx1 = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime1.startPhase(ctx1 as any, "ralphi-init", "");
		const runId = extractRunId(api1.sendUserMessages);

		await runtime1.markPhaseDone(ctx1 as any, {
			runId,
			phase: "ralphi-init",
			summary: "Done",
			outputs: [],
		});

		// New runtime, strip branchWithSummary from sessionManager
		const api2 = createMockExtensionApi(sessionManager);
		const runtime2 = new RalphiRuntime(api2 as any);
		(runtime2 as any).pendingFinalizeRuns.add(runId);

		const strippedSessionManager = { ...sessionManager } as any;
		delete strippedSessionManager.branchWithSummary;
		const turnEndCtx = createMockCommandContext({ sessionManager: strippedSessionManager, cwd: tempDir });
		await runtime2.handleTurnEnd(turnEndCtx as any);

		// Should fall back to manual finalize prompt
		expect(turnEndCtx.ui.notifications.some(
			(n: { message: string; level: string }) =>
				n.level === "warning" && n.message.includes("ralphi-finalize"),
		)).toBe(true);
	});

	it("prefers navigateTree (primary path) when commandContext is available", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = new RalphiRuntime(api as any);
		const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

		await runtime.startPhase(ctx as any, "ralphi-init", "");
		const runId = extractRunId(api.sendUserMessages);

		await runtime.markPhaseDone(ctx as any, {
			runId,
			phase: "ralphi-init",
			summary: "Done",
			outputs: [],
		});

		await runtime.handleTurnEnd(ctx as any);

		// navigateTree should be used (primary path), NOT branchWithSummary
		expect(ctx.navigateCalls).toHaveLength(1);
		expect(sessionManager.branchWithSummaryCalls).toHaveLength(0);
	});
});
