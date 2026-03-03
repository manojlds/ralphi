import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RalphiRuntime } from "./runtime";

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
			const trimmed = args.trim();
			if (!trimmed) {
				ctx.ui.notify("Usage: /ralphi-prd <name> [description]", "warning");
				return;
			}
			await runtime.startPhase(ctx, "ralphi-prd", trimmed);
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
