import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerCommands } from "../src/commands";
import { createMockCommandContext, createMockExtensionApi, createMockSessionManager, createMockUi } from "./factories/pi";

describe("ralphi command behavior", () => {
	it("prompts for missing /ralphi-prd args via TUI input", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const startPhase = vi.fn(async () => undefined);
		const runtime = {
			startPhase,
			finalizeRun: vi.fn(),
			startLoop: vi.fn(),
			runLoopIteration: vi.fn(),
			stopLoop: vi.fn(),
			openLoop: vi.fn(),
			openLoopController: vi.fn(),
			showLoopStatus: vi.fn(),
		};
		registerCommands(api as any, runtime as any);

		const command = api.registeredCommands.get("ralphi-prd") as { handler: (args: string, ctx: any) => Promise<void> };
		const ui = createMockUi([], ["billing-report", "Generate a billing report workflow"]);
		const ctx = createMockCommandContext({ sessionManager, ui });

		await command.handler("", ctx as any);

		expect(ui.inputCalls).toEqual([
			{ title: "PRD name", placeholder: "e.g. user-auth" },
			{ title: "PRD description", placeholder: "Describe the feature to plan" },
		]);
		expect(startPhase).toHaveBeenCalledTimes(1);
		expect(startPhase).toHaveBeenCalledWith(ctx, "ralphi-prd", "billing-report Generate a billing report workflow");
	});

	it("aborts /ralphi-prd when prompted name is empty", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const startPhase = vi.fn(async () => undefined);
		const runtime = {
			startPhase,
			finalizeRun: vi.fn(),
			startLoop: vi.fn(),
			runLoopIteration: vi.fn(),
			stopLoop: vi.fn(),
			openLoop: vi.fn(),
			openLoopController: vi.fn(),
			showLoopStatus: vi.fn(),
		};
		registerCommands(api as any, runtime as any);

		const command = api.registeredCommands.get("ralphi-prd") as { handler: (args: string, ctx: any) => Promise<void> };
		const ui = createMockUi([], [undefined]);
		const ctx = createMockCommandContext({ sessionManager, ui });

		await command.handler("", ctx as any);

		expect(startPhase).not.toHaveBeenCalled();
		expect(ui.notifications.some((entry) => entry.message.includes("PRD name is required"))).toBe(true);
	});

	it("aborts /ralphi-prd when description is missing", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const startPhase = vi.fn(async () => undefined);
		const runtime = {
			startPhase,
			finalizeRun: vi.fn(),
			startLoop: vi.fn(),
			runLoopIteration: vi.fn(),
			stopLoop: vi.fn(),
			openLoop: vi.fn(),
			openLoopController: vi.fn(),
			showLoopStatus: vi.fn(),
			showLoopGuidance: vi.fn(),
			setLoopGuidance: vi.fn(),
			clearLoopGuidance: vi.fn(),
		};
		registerCommands(api as any, runtime as any);

		const command = api.registeredCommands.get("ralphi-prd") as { handler: (args: string, ctx: any) => Promise<void> };
		const ui = createMockUi([], [undefined]);
		const ctx = createMockCommandContext({ sessionManager, ui });

		await command.handler("billing-report", ctx as any);

		expect(ui.inputCalls).toEqual([{ title: "PRD description", placeholder: "Describe the feature to plan" }]);
		expect(startPhase).not.toHaveBeenCalled();
		expect(ui.notifications.some((entry) => entry.message.includes("PRD description is required"))).toBe(true);
	});

	it("prompts for available PRDs in /ralphi-convert when args are missing in TUI mode", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-convert-command-"));
		try {
			fs.mkdirSync(path.join(tempDir, "tasks"), { recursive: true });
			fs.writeFileSync(path.join(tempDir, "tasks", "prd-auth.md"), "# auth\n", "utf8");
			fs.writeFileSync(path.join(tempDir, "tasks", "prd-billing.md"), "# billing\n", "utf8");
			fs.writeFileSync(path.join(tempDir, "tasks", "notes.md"), "# not a prd\n", "utf8");

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const startPhase = vi.fn(async () => undefined);
			const runtime = {
				startPhase,
				finalizeRun: vi.fn(),
				startLoop: vi.fn(),
				runLoopIteration: vi.fn(),
				stopLoop: vi.fn(),
				openLoop: vi.fn(),
				openLoopController: vi.fn(),
				showLoopStatus: vi.fn(),
				showLoopGuidance: vi.fn(),
				setLoopGuidance: vi.fn(async () => undefined),
				clearLoopGuidance: vi.fn(),
			};
			registerCommands(api as any, runtime as any);

			const command = api.registeredCommands.get("ralphi-convert") as { handler: (args: string, ctx: any) => Promise<void> };
			const ui = createMockUi([], [], ["tasks/prd-billing.md"]);
			const ctx = createMockCommandContext({ sessionManager, ui, cwd: tempDir });

			await command.handler("", ctx as any);

			expect(ui.selectCalls).toEqual([
				{
					title: "Select PRD file to convert",
					options: ["tasks/prd-auth.md", "tasks/prd-billing.md"],
				},
			]);
			expect(startPhase).toHaveBeenCalledWith(ctx, "ralphi-convert", "tasks/prd-billing.md");
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("warns for /ralphi-convert with missing args when not in TUI mode", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const startPhase = vi.fn(async () => undefined);
		const runtime = {
			startPhase,
			finalizeRun: vi.fn(),
			startLoop: vi.fn(),
			runLoopIteration: vi.fn(),
			stopLoop: vi.fn(),
			openLoop: vi.fn(),
			openLoopController: vi.fn(),
			showLoopStatus: vi.fn(),
			showLoopGuidance: vi.fn(),
			setLoopGuidance: vi.fn(async () => undefined),
			clearLoopGuidance: vi.fn(),
		};
		registerCommands(api as any, runtime as any);

		const command = api.registeredCommands.get("ralphi-convert") as { handler: (args: string, ctx: any) => Promise<void> };
		const ctx = createMockCommandContext({ sessionManager, hasUI: false });

		await command.handler("", ctx as any);

		expect(startPhase).not.toHaveBeenCalled();
		expect(ctx.ui.notifications.some((entry) => entry.message.includes("Usage: /ralphi-convert <prd-file>"))).toBe(true);
	});

	it("warns when /ralphi-convert cannot find PRD markdown files in tasks/", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ralphi-convert-empty-"));
		try {
			fs.mkdirSync(path.join(tempDir, "tasks"), { recursive: true });
			fs.writeFileSync(path.join(tempDir, "tasks", "notes.md"), "# none\n", "utf8");

			const sessionManager = createMockSessionManager();
			const api = createMockExtensionApi(sessionManager);
			const startPhase = vi.fn(async () => undefined);
			const runtime = {
				startPhase,
				finalizeRun: vi.fn(),
				startLoop: vi.fn(),
				runLoopIteration: vi.fn(),
				stopLoop: vi.fn(),
				openLoop: vi.fn(),
				openLoopController: vi.fn(),
				showLoopStatus: vi.fn(),
				showLoopGuidance: vi.fn(),
				setLoopGuidance: vi.fn(async () => undefined),
				clearLoopGuidance: vi.fn(),
			};
			registerCommands(api as any, runtime as any);

			const command = api.registeredCommands.get("ralphi-convert") as { handler: (args: string, ctx: any) => Promise<void> };
			const ui = createMockUi();
			const ctx = createMockCommandContext({ sessionManager, ui, cwd: tempDir });

			await command.handler("", ctx as any);

			expect(startPhase).not.toHaveBeenCalled();
			expect(ui.notifications.some((entry) => entry.message.includes("No PRD markdown files found under tasks/"))).toBe(true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers loop guidance commands that delegate to runtime", async () => {
		const sessionManager = createMockSessionManager();
		const api = createMockExtensionApi(sessionManager);
		const runtime = {
			startPhase: vi.fn(),
			finalizeRun: vi.fn(),
			startLoop: vi.fn(),
			runLoopIteration: vi.fn(),
			stopLoop: vi.fn(),
			openLoop: vi.fn(),
			openLoopController: vi.fn(),
			showLoopStatus: vi.fn(),
			showLoopGuidance: vi.fn(),
			setLoopGuidance: vi.fn(async () => undefined),
			clearLoopGuidance: vi.fn(),
		};
		registerCommands(api as any, runtime as any);

		const show = api.registeredCommands.get("ralphi-loop-guidance-show") as {
			handler: (args: string, ctx: any) => Promise<void>;
		};
		const set = api.registeredCommands.get("ralphi-loop-guidance-set") as {
			handler: (args: string, ctx: any) => Promise<void>;
		};
		const clear = api.registeredCommands.get("ralphi-loop-guidance-clear") as {
			handler: (args: string, ctx: any) => Promise<void>;
		};

		const ctx = createMockCommandContext({ sessionManager });
		await show.handler("", ctx as any);
		await set.handler("Prefer focused diffs", ctx as any);
		await clear.handler("", ctx as any);

		expect(runtime.showLoopGuidance).toHaveBeenCalledWith(ctx);
		expect(runtime.setLoopGuidance).toHaveBeenCalledWith(ctx, "Prefer focused diffs");
		expect(runtime.clearLoopGuidance).toHaveBeenCalledWith(ctx);
	});
});
