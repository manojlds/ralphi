import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { RalphiRuntime } from "./runtime";

export function registerEvents(pi: ExtensionAPI, runtime: RalphiRuntime) {
	pi.on("session_start", (_event, ctx) => {
		runtime.handleSessionStart(ctx);
	});

	pi.on("session_switch", (_event, ctx) => {
		runtime.handleSessionSwitch(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		return runtime.handleBeforeAgentStart(event, ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		await runtime.handleTurnEnd(ctx);
	});

	pi.on("session_before_tree", (event) => {
		return runtime.handleBeforeTree(event);
	});
}
