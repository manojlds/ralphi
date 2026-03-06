import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RalphiRuntime } from "../src/runtime";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager } from "./factories/pi";

function createRuntime() {
	const sessionManager = createMockSessionManager();
	const api = createMockExtensionApi(sessionManager);
	return new RalphiRuntime(api as any);
}

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-reflection-config-"));
}

describe("loop reflection config model", () => {
	it("defaults reflection settings to disabled when unset", () => {
		const runtime = createRuntime();
		const parsed = (runtime as any).parseConfigYaml([
			"loop:",
			'  guidance: "Keep changes small"',
			"  reviewPasses: 2",
			'  trajectoryGuard: "warn_on_drift"',
			"",
		].join("\n"));

		expect(parsed.guidance).toBe("Keep changes small");
		expect(parsed.controls.reviewPasses).toBe(2);
		expect(parsed.controls.trajectoryGuard).toBe("warn_on_drift");
		expect(parsed.reflection.reflectEvery).toBeNull();
		expect(parsed.reflection.reflectInstructions).toBeNull();
	});

	it("parses configured reflection cadence and custom instructions", () => {
		const runtime = createRuntime();
		const parsed = (runtime as any).parseConfigYaml([
			"loop:",
			"  reflectEvery: 3",
			'  reflectInstructions: "Re-evaluate risks, drift, and next plan."',
			"",
		].join("\n"));

		expect(parsed.reflection.reflectEvery).toBe(3);
		expect(parsed.reflection.reflectInstructions).toBe("Re-evaluate risks, drift, and next plan.");
	});

	it("treats non-positive or malformed reflection values as disabled without crashing", () => {
		const runtime = createRuntime();
		const parsed = (runtime as any).parseConfigYaml([
			"loop:",
			"  reflectEvery: 0",
			"  reflectInstructions:",
			"    malformed: true",
			"  reviewPasses: 2",
			'  trajectoryGuard: "require_corrective_plan"',
			"",
		].join("\n"));

		expect(parsed.reflection.reflectEvery).toBeNull();
		expect(parsed.reflection.reflectInstructions).toBeNull();
		expect(parsed.controls.reviewPasses).toBe(2);
		expect(parsed.controls.trajectoryGuard).toBe("require_corrective_plan");
	});

	it("preserves reflection settings when guidance is set or cleared", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "config.yaml"),
				[
					"loop:",
					"  reflectEvery: 4",
					'  reflectInstructions: "Pause and validate PRD trajectory every checkpoint."',
					"",
				].join("\n"),
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.setLoopGuidance(ctx as any, "Always map changed files to acceptance criteria.");
			let config = fs.readFileSync(path.join(tempDir, ".ralphi", "config.yaml"), "utf8");
			expect(config).toContain("reflectEvery: 4");
			expect(config).toContain("reflectInstructions");
			expect(config).toContain("Always map changed files to acceptance criteria.");

			runtime.clearLoopGuidance(ctx as any);
			config = fs.readFileSync(path.join(tempDir, ".ralphi", "config.yaml"), "utf8");
			expect(config).toContain("reflectEvery: 4");
			expect(config).toContain("reflectInstructions");
			expect(config).not.toContain("guidance:");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
