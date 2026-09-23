/**
 * Default-deny `ExtensionUIContext` for a headless session host.
 *
 * No TUI is ever constructed (docs/architecture.md §2): every awaitable resolves
 * immediately — an unsettled dialog promise is the only way to hang a session —
 * and every mutating surface is a no-op.
 *
 * `theme` reads the live global theme binding, so callers must `await initTheme()`
 * (see session-host.ts) before the context is handed to tools/extensions.
 */

import { theme as globalTheme, type ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";

export function createStubUIContext(): ExtensionUIContext {
	return {
		// Awaitables resolve immediately; undefined/false are mapped to Deny upstream.
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		editor: async () => undefined,
		custom: async () => undefined as never,
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "headless" }),
		getEditorText: () => "",
		getToolsExpanded: () => false,
		onTerminalInput: () => () => {},
		// No-ops: nothing here renders.
		notify: () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		setEditorText: () => {},
		pasteToEditor: () => {},
		setEditorComponent: () => {},
		setToolsExpanded: () => {},
		get theme() {
			return globalTheme;
		},
	};
}
