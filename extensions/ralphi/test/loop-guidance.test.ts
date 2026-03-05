import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RalphiRuntime } from "../src/runtime";
import {
	createMockCommandContext,
	createMockExtensionApi,
	createMockSessionManager,
} from "./factories/pi";

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-loop-guidance-"));
}

describe("project-local loop guidance", () => {
	it("supports set/show/clear guidance via runtime command handlers", async () => {
		const tempDir = createTempDir();
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			runtime.showLoopGuidance(ctx as any);
			expect(ctx.ui.notifications.at(-1)?.message).toContain("No loop guidance configured");

			await runtime.setLoopGuidance(ctx as any, "Always run npm run check before ralphi_phase_done.");

			const guidancePath = path.join(tempDir, ".ralphi", "loop-guidance.md");
			expect(fs.existsSync(guidancePath)).toBe(true);
			expect(fs.readFileSync(guidancePath, "utf8")).toContain("Always run npm run check");

			runtime.showLoopGuidance(ctx as any);
			expect(ctx.ui.notifications.at(-1)?.message).toContain("Always run npm run check");

			runtime.clearLoopGuidance(ctx as any);
			expect(fs.existsSync(guidancePath)).toBe(false);
			expect(ctx.ui.notifications.at(-1)?.message).toContain("Cleared loop guidance");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("injects .ralphi/loop-guidance.md into loop iteration system prompt when present", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "loop-guidance.md"),
				"Prefer small commits and include acceptance-criteria mapping in progress.txt.\n",
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");

			const injected = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);
			expect(injected).toBeDefined();
			expect(injected!.systemPrompt).toContain("[PROJECT LOOP GUIDANCE]");
			expect(injected!.systemPrompt).toContain(".ralphi/loop-guidance.md");
			expect(injected!.systemPrompt).toContain("Prefer small commits");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to default loop prompt when guidance file is missing", async () => {
		const tempDir = createTempDir();
		try {
			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");

			const injected = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);
			expect(injected).toBeDefined();
			expect(injected!.systemPrompt).toContain("[RALPHI PHASE]");
			expect(injected!.systemPrompt).not.toContain("[PROJECT LOOP GUIDANCE]");
			expect(injected!.systemPrompt).not.toContain(".ralphi/loop-guidance.md");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not inject loop guidance into non-loop phases", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(path.join(tempDir, ".ralphi", "loop-guidance.md"), "Loop-only guidance\n", "utf8");

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startPhase(ctx as any, "ralphi-init", "");

			const injected = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);
			expect(injected).toBeDefined();
			expect(injected!.systemPrompt).not.toContain("[PROJECT LOOP GUIDANCE]");
			expect(injected!.systemPrompt).not.toContain("Loop-only guidance");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("removes guidance injection after clear + session switch roundtrip", async () => {
		const tempDir = createTempDir();
		try {
			fs.mkdirSync(path.join(tempDir, ".ralphi"), { recursive: true });
			fs.writeFileSync(
				path.join(tempDir, ".ralphi", "loop-guidance.md"),
				"Keep implementation tightly scoped to one story per iteration.\n",
				"utf8",
			);

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const runtime = new RalphiRuntime(api as any);
			const ctx = createMockCommandContext({ sessionManager, cwd: tempDir });

			await runtime.startLoop(ctx as any, "--max-iterations 2");
			const iterationSessionFile = sessionManager.getSessionFile();

			const beforeClear = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);
			expect(beforeClear!.systemPrompt).toContain("Keep implementation tightly scoped");

			runtime.clearLoopGuidance(ctx as any);

			await ctx.switchSession("session-controller.json");
			runtime.handleSessionSwitch(ctx as any);
			await ctx.switchSession(iterationSessionFile);
			runtime.handleSessionSwitch(ctx as any);

			const afterClear = runtime.handleBeforeAgentStart({ systemPrompt: "base prompt" } as any, ctx as any);
			expect(afterClear).toBeDefined();
			expect(afterClear!.systemPrompt).not.toContain("[PROJECT LOOP GUIDANCE]");
			expect(afterClear!.systemPrompt).not.toContain("Keep implementation tightly scoped");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
