import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { RalphiRuntime } from "./runtime";

function parsePrdArgs(args: string): { name: string; description: string } {
	const trimmed = args.trim();
	if (!trimmed) return { name: "", description: "" };
	const [name, ...rest] = trimmed.split(/\s+/);
	return {
		name: name?.trim() ?? "",
		description: rest.join(" ").trim(),
	};
}

async function resolvePrdArgs(args: string, ctx: ExtensionCommandContext): Promise<string | null> {
	const usage = "Usage: /ralphi-prd <name> <description>";
	let { name, description } = parsePrdArgs(args);

	if (!name) {
		if (!ctx.hasUI) {
			ctx.ui.notify(usage, "warning");
			return null;
		}

		const inputName = await ctx.ui.input("PRD name", "e.g. user-auth");
		name = inputName?.trim() ?? "";
		if (!name) {
			ctx.ui.notify("PRD name is required to start /ralphi-prd.", "warning");
			return null;
		}
	}

	if (!description) {
		if (!ctx.hasUI) {
			ctx.ui.notify(usage, "warning");
			return null;
		}

		const inputDescription = await ctx.ui.input("PRD description", "Describe the feature to plan");
		description = inputDescription?.trim() ?? "";
		if (!description) {
			ctx.ui.notify("PRD description is required to start /ralphi-prd.", "warning");
			return null;
		}
	}

	return `${name} ${description}`;
}

export function registerCommands(pi: ExtensionAPI, runtime: RalphiRuntime) {
	pi.registerCommand("ralphi-init", {
		description: "Run ralphi-init skill with completion handshake + tree rewind",
		handler: async (_args, ctx) => {
			await runtime.startPhase(ctx, "ralphi-init", "");
		},
	});

	pi.registerCommand("ralphi-prd", {
		description: "Run ralphi-prd skill with completion handshake + tree rewind",
		handler: async (args, ctx) => {
			const resolved = await resolvePrdArgs(args, ctx);
			if (!resolved) return;
			await runtime.startPhase(ctx, "ralphi-prd", resolved);
		},
	});

	pi.registerCommand("ralphi-convert", {
		description: "Run ralphi-convert skill with completion handshake + tree rewind",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /ralphi-convert <prd-file>", "warning");
				return;
			}
			await runtime.startPhase(ctx, "ralphi-convert", trimmed);
		},
	});

	pi.registerCommand("ralphi-finalize", {
		description: "Finalize an active ralphi run (internal)",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (!runId) {
				ctx.ui.notify("Usage: /ralphi-finalize <runId>", "warning");
				return;
			}
			await runtime.finalizeRun(ctx, runId);
		},
	});

	pi.registerCommand("ralphi-loop-start", {
		description: "Start automatic fresh-context ralphi loop",
		handler: async (args, ctx) => {
			await runtime.startLoop(ctx, args);
		},
	});

	pi.registerCommand("ralphi-loop-next", {
		description: "Run the next ralphi loop iteration (internal)",
		handler: async (args, ctx) => {
			const loopId = args.trim();
			if (!loopId) {
				ctx.ui.notify("Usage: /ralphi-loop-next <loopId>", "warning");
				return;
			}
			await runtime.runLoopIteration(ctx, loopId);
		},
	});

	pi.registerCommand("ralphi-loop-stop", {
		description: "Request stop for active ralphi loop",
		handler: async (args, ctx) => {
			await runtime.stopLoop(ctx, args);
		},
	});

	pi.registerCommand("ralphi-loop-open", {
		description: "Switch to active loop iteration session to inspect in-flight work",
		handler: async (args, ctx) => {
			await runtime.openLoop(ctx, args);
		},
	});

	pi.registerCommand("ralphi-loop-controller", {
		description: "Switch back to loop controller session",
		handler: async (args, ctx) => {
			await runtime.openLoopController(ctx, args);
		},
	});

	pi.registerCommand("ralphi-loop-status", {
		description: "Show ralphi phase/loop status",
		handler: async (_args, ctx) => {
			runtime.showLoopStatus(ctx);
		},
	});
}
