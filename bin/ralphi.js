#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function printUsage() {
	console.log(`ralphi CLI

Usage:
  ralphi check [--config <path>]
  ralphi --help

Commands:
  check    Run quality commands from .ralphi/config.yaml
`);
}

function parseCommandArgs(args) {
	const result = { configPath: ".ralphi/config.yaml" };
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--config") {
			const value = args[i + 1];
			if (!value) {
				throw new Error("Missing value for --config");
			}
			result.configPath = value;
			i += 1;
			continue;
		}
		if (arg === "-h" || arg === "--help") {
			result.help = true;
			continue;
		}
		throw new Error(`Unknown option: ${arg}`);
	}
	return result;
}

function stripInlineComment(value) {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (char === "'" && !inDouble) inSingle = !inSingle;
		if (char === '"' && !inSingle) inDouble = !inDouble;
		if (char === "#" && !inSingle && !inDouble) {
			return value.slice(0, i).trimEnd();
		}
	}
	return value.trimEnd();
}

function unquote(value) {
	if (value.length < 2) return value;
	const first = value[0];
	const last = value[value.length - 1];
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}

function readCommandsFromConfig(configPath) {
	const absolute = path.resolve(process.cwd(), configPath);
	if (!fs.existsSync(absolute)) {
		throw new Error(`Config not found: ${absolute}`);
	}
	const text = fs.readFileSync(absolute, "utf8");
	const lines = text.split(/\r?\n/);

	let inCommands = false;
	const commands = [];

	for (const rawLine of lines) {
		const line = rawLine.replace(/\t/g, "    ");
		const trimmed = line.trim();
		if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

		if (!inCommands) {
			if (/^commands:\s*$/.test(trimmed)) {
				inCommands = true;
			}
			continue;
		}

		if (!line.startsWith("  ") && /^[A-Za-z0-9_-]+\s*:/.test(trimmed)) {
			break;
		}

		const match = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.+?)\s*$/);
		if (!match) continue;
		const key = match[1];
		const rawValue = stripInlineComment(match[2]).trim();
		if (!rawValue) continue;
		commands.push([key, unquote(rawValue)]);
	}

	if (commands.length === 0) {
		throw new Error(`No commands found in ${absolute}. Expected a 'commands:' mapping.`);
	}

	const preferredOrder = ["lint", "typecheck", "test", "build"];
	const ordered = [];
	for (const key of preferredOrder) {
		const found = commands.find(([name]) => name === key);
		if (found) ordered.push(found);
	}
	for (const pair of commands) {
		if (!ordered.some(([name]) => name === pair[0])) {
			ordered.push(pair);
		}
	}
	return ordered;
}

function runShell(command) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			shell: true,
			stdio: "inherit",
			cwd: process.cwd(),
			env: process.env,
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`Command terminated by signal: ${signal}`));
				return;
			}
			resolve(code ?? 1);
		});
	});
}

async function runCheck(args) {
	const parsed = parseCommandArgs(args);
	if (parsed.help) {
		printUsage();
		return 0;
	}

	const commands = readCommandsFromConfig(parsed.configPath);

	console.log(`[ralphi] Using config: ${path.resolve(process.cwd(), parsed.configPath)}`);
	for (const [name, command] of commands) {
		console.log(`\n[ralphi] ▶ ${name}: ${command}`);
		const code = await runShell(command);
		if (code !== 0) {
			console.error(`\n[ralphi] ✖ ${name} failed (exit ${code})`);
			return code;
		}
	}

	console.log("\n[ralphi] ✓ All configured checks passed");
	return 0;
}

async function main() {
	const [, , command, ...args] = process.argv;
	if (!command || command === "-h" || command === "--help" || command === "help") {
		printUsage();
		process.exit(0);
	}

	if (command === "check") {
		const code = await runCheck(args);
		process.exit(code);
	}

	console.error(`Unknown command: ${command}`);
	printUsage();
	process.exit(1);
}

main().catch((error) => {
	console.error(`[ralphi] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
