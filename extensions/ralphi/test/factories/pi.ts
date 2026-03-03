type NotifyLevel = "info" | "warning" | "error";

export type MockCustomEntry = {
	id: string;
	type: "custom";
	customType: string;
	data: Record<string, unknown>;
};

export type MockUi = {
	notifications: Array<{ message: string; level: NotifyLevel }>;
	statuses: Array<{ key: string; text: string | undefined }>;
	confirmCalls: Array<{ title: string; message: string }>;
	confirmResponses: boolean[];
	notify: (message: string, level: NotifyLevel) => void;
	setStatus: (key: string, text: string | undefined) => void;
	confirm: (title: string, message: string) => Promise<boolean>;
};

export type MockSessionManager = {
	getSessionFile: () => string;
	getSessionId: () => string;
	getLeafId: () => string | null;
	getEntries: () => MockCustomEntry[];
	getBranch: () => MockCustomEntry[];
	switchTo: (sessionFile: string) => void;
	appendCustom: (customType: string, data: Record<string, unknown>) => MockCustomEntry;
};

export type MockExtensionApi = {
	sendUserMessages: Array<{ text: string; options?: Record<string, unknown> }>;
	labels: Array<{ id: string; label: string }>;
	sessionNames: string[];
	registeredCommands: Map<string, unknown>;
	registeredTools: unknown[];
	registeredEvents: Map<string, unknown[]>;
	sendUserMessage: (text: string, options?: Record<string, unknown>) => void;
	appendEntry: (customType: string, data: Record<string, unknown>) => void;
	setLabel: (id: string, label: string) => void;
	setSessionName: (name: string) => void;
	registerCommand: (name: string, config: unknown) => void;
	registerTool: (tool: unknown) => void;
	on: (event: string, handler: unknown) => void;
};

let entryCounter = 0;
let sessionCounter = 0;

function nextEntryId() {
	entryCounter += 1;
	return `entry-${entryCounter}`;
}

function nextSessionFile() {
	sessionCounter += 1;
	return `session-${sessionCounter}.json`;
}

export function createMockSessionManager(initialSessionFile = "session-controller.json"): MockSessionManager {
	const sessions = new Map<string, MockCustomEntry[]>();
	sessions.set(initialSessionFile, []);

	let currentSessionFile = initialSessionFile;

	const ensureSession = (sessionFile: string) => {
		if (!sessions.has(sessionFile)) sessions.set(sessionFile, []);
		return sessions.get(sessionFile)!;
	};

	return {
		getSessionFile: () => currentSessionFile,
		getSessionId: () => currentSessionFile,
		getLeafId: () => {
			const entries = ensureSession(currentSessionFile);
			return entries.length > 0 ? entries[entries.length - 1].id : null;
		},
		getEntries: () => ensureSession(currentSessionFile),
		getBranch: () => ensureSession(currentSessionFile),
		switchTo: (sessionFile: string) => {
			ensureSession(sessionFile);
			currentSessionFile = sessionFile;
		},
		appendCustom: (customType: string, data: Record<string, unknown>) => {
			const entry: MockCustomEntry = {
				id: nextEntryId(),
				type: "custom",
				customType,
				data,
			};
			ensureSession(currentSessionFile).push(entry);
			return entry;
		},
	};
}

export function createMockUi(confirmResponses: boolean[] = []): MockUi {
	return {
		notifications: [],
		statuses: [],
		confirmCalls: [],
		confirmResponses: [...confirmResponses],
		notify(message, level) {
			this.notifications.push({ message, level });
		},
		setStatus(key, text) {
			this.statuses.push({ key, text });
		},
		async confirm(title, message) {
			this.confirmCalls.push({ title, message });
			return this.confirmResponses.length > 0 ? this.confirmResponses.shift()! : true;
		},
	};
}

export function createMockExtensionApi(sessionManager: MockSessionManager): MockExtensionApi {
	return {
		sendUserMessages: [],
		labels: [],
		sessionNames: [],
		registeredCommands: new Map(),
		registeredTools: [],
		registeredEvents: new Map(),
		sendUserMessage(text, options) {
			this.sendUserMessages.push({ text, options });
		},
		appendEntry(customType, data) {
			sessionManager.appendCustom(customType, data);
		},
		setLabel(id, label) {
			this.labels.push({ id, label });
		},
		setSessionName(name) {
			this.sessionNames.push(name);
		},
		registerCommand(name, config) {
			this.registeredCommands.set(name, config);
		},
		registerTool(tool) {
			this.registeredTools.push(tool);
		},
		on(event, handler) {
			const existing = this.registeredEvents.get(event) ?? [];
			existing.push(handler);
			this.registeredEvents.set(event, existing);
		},
	};
}

export function createMockCommandContext(options?: {
	cwd?: string;
	sessionManager?: MockSessionManager;
	ui?: MockUi;
	idle?: boolean;
	hasUI?: boolean;
	navigateCancelled?: boolean;
	switchCancelled?: boolean;
	newSessionCancelled?: boolean;
}) {
	const sessionManager = options?.sessionManager ?? createMockSessionManager();
	const ui = options?.ui ?? createMockUi();
	const idle = options?.idle ?? true;

	const ctx = {
		cwd: options?.cwd ?? process.cwd(),
		hasUI: options?.hasUI ?? true,
		sessionManager,
		ui,
		navigateCalls: [] as Array<{ leafId: string; options?: Record<string, unknown> }>,
		switchCalls: [] as string[],
		newSessionCalls: [] as Array<Record<string, unknown>>,
		isIdle: () => idle,
		switchSession: async (sessionFile: string) => {
			ctx.switchCalls.push(sessionFile);
			if (options?.switchCancelled) return { cancelled: true };
			sessionManager.switchTo(sessionFile);
			return { cancelled: false };
		},
		navigateTree: async (leafId: string, navigateOptions?: Record<string, unknown>) => {
			ctx.navigateCalls.push({ leafId, options: navigateOptions });
			return { cancelled: options?.navigateCancelled ?? false };
		},
		newSession: async (newSessionOptions: Record<string, unknown>) => {
			ctx.newSessionCalls.push(newSessionOptions);
			if (options?.newSessionCancelled) return { cancelled: true };
			const sessionFile = nextSessionFile();
			sessionManager.switchTo(sessionFile);
			return { cancelled: false, sessionFile };
		},
	};

	return ctx;
}
