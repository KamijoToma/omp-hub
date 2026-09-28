/**
 * Collab-backed `ExtensionUIContext` for the headless session host.
 *
 * The SDK's `ask` tool refuses to run without a UI surface (`createIf` gates on
 * `canPromptUser`, `execute` on `context.hasUI`), and the stock stub would deny
 * every dialog instantly. This bridge instead surfaces `askDialog`/`select`/
 * `editor` to collab guests through `CollabHost.requestGuestUi` — the same
 * mirror the interactive TUI raises (`extension-ui-controller.ts`), minus the
 * local TUI half. A writable guest answers via `ui-response`; the web
 * composer already renders these requests (proto ≥ 3 wire grammar).
 *
 * Deny semantics keep the host's default-deny contract: when no room exists,
 * traffic is gated, the pending cap is hit, the caller aborts, or the guest
 * side tears down, every awaitable settles immediately with
 * `undefined`/`false` — AskTool then reports a cancellation and aborts the
 * turn instead of stranding a promise. With a live room but zero connected
 * guests the request is *retained* by CollabHost until the first writer
 * joins (its documented behavior), which is the headless analogue of a TUI
 * dialog waiting at the keyboard; `ask.timeout` bounds it when configured.
 */

import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { CollabUiRequestDraft, CollabUiSelectItem } from "@oh-my-pi/pi-wire";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionAskDialogResultItem,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUISelectItem,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createStubUIContext } from "./ui-stub";

/** Reserved runtime labels; must match AskTool's `RESERVED_OPTION_LABELS` and the TUI controller. */
const ASK_OTHER_OPTION = "Other (type your own)";
const ASK_CHAT_OPTION = "Chat about this";
const ASK_NEXT_OPTION = "Next →";

/** Hard cap on one wire title; the web composer scrolls, but bounded is bounded. */
const MAX_TITLE_CHARS = 200;

/** Strip `\r` runs so web-rendered labels/questions read as prose. Mirrors pi-tui render-utils. */
function sanitizeCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text.replaceAll("\r\n", "\n").replace(/\r+/g, " ");
}

/**
 * Sanitize raw option labels into unique, action-safe display copies. Verbatim
 * replica of pi-tui `disambiguateDisplayLabels` — answers are keyed by display
 * label, so collisions with reserved runtime labels or sibling options would
 * corrupt the selection mapping.
 */
function disambiguateDisplayLabels(rawLabels: string[], reservedLabels: readonly string[]): string[] {
	const taken = new Set<string>(reservedLabels);
	return rawLabels.map(raw => {
		const base = sanitizeCarriageReturns(raw);
		let candidate = base;
		for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base} (${suffix})`;
		taken.add(candidate);
		return candidate;
	});
}

/** Single-line bounded title for wire requests. */
function boundAskTitle(prefix: string, question: string): string {
	const flat = sanitizeCarriageReturns(`${prefix}${question}`).replaceAll("\n", " ").trim();
	return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat;
}

/** One round trip to the writable guests: `null` (no room/gated) and
 * `unavailable` (aborted/teardown) both deny; a string answer resolves. */
async function requestGuestString(
	getHost: () => CollabHost | undefined,
	request: CollabUiRequestDraft,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	const host = getHost();
	const remote = host?.requestGuestUi(request, signal);
	if (!remote) return undefined;
	const result = await remote;
	return result.kind === "answered" && typeof result.value === "string" ? result.value : undefined;
}

/** Ask one question through the guests (TUI controller's `#runGuestAskQuestion`). */
async function askGuestQuestion(
	getHost: () => CollabHost | undefined,
	question: ExtensionAskDialogQuestion,
	signal: AbortSignal | undefined,
): Promise<ExtensionAskDialogResultItem | "chat" | undefined> {
	const selected = new Set<string>();
	let customInput: string | undefined;
	// Display copies guard reserved-label collisions; answers map back to the
	// ORIGINAL labels so the persisted result correlates with the call args.
	const displayLabels = disambiguateDisplayLabels(
		question.options.map(option => option.label),
		[ASK_OTHER_OPTION, ASK_CHAT_OPTION, ASK_NEXT_OPTION],
	);
	const originalByDisplay = new Map<string, string>();
	question.options.forEach((option, index) => {
		originalByDisplay.set(displayLabels[index]!, option.label);
	});
	const resolveGuestLabel = (value: string): string => originalByDisplay.get(value) ?? value;
	const displayQuestion = sanitizeCarriageReturns(question.question);
	const baseOptions: CollabUiSelectItem[] = question.options.map((option, index) =>
		option.description?.trim()
			? { label: displayLabels[index]!, description: sanitizeCarriageReturns(option.description.trim()) }
			: displayLabels[index]!,
	);
	const customAnswerTitle = boundAskTitle("Custom answer: ", displayQuestion);

	if (question.multi) {
		// Checkbox loop: every toggle re-requests with fresh `checkedIndices`;
		// `Next →` only appears once an answer exists so a guest cannot submit
		// an empty multi-select (matches the TUI dialog's gating).
		for (;;) {
			const checkedIndices = question.options
				.map((_, index) => (selected.has(question.options[index]!.label) ? index : -1))
				.filter(index => index >= 0);
			const hasAnswer = selected.size > 0 || customInput !== undefined;
			const options: CollabUiSelectItem[] = [...baseOptions, ASK_OTHER_OPTION];
			if (hasAnswer) options.push(ASK_NEXT_OPTION);
			options.push(ASK_CHAT_OPTION);
			const choice = await requestGuestString(
				getHost,
				{
					kind: "select",
					title: displayQuestion,
					options,
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: question.options.length,
					helpText: hasAnswer
						? "click toggles  Next → continue  Cancel dismisses"
						: "click toggles  Cancel dismisses",
				},
				signal,
			);
			if (choice === undefined) return undefined;
			if (choice === ASK_CHAT_OPTION) return "chat";
			if (choice === ASK_NEXT_OPTION) break;
			if (choice === ASK_OTHER_OPTION) {
				const input = await requestGuestString(getHost, { kind: "editor", title: customAnswerTitle }, signal);
				// Guest cancelled the editor: re-show the checkboxes instead of
				// cancelling the whole ask.
				if (input === undefined) continue;
				customInput = input;
				break;
			}
			const picked = resolveGuestLabel(choice);
			if (selected.has(picked)) selected.delete(picked);
			else selected.add(picked);
		}
	} else {
		const recommended =
			typeof question.recommended === "number" && Number.isInteger(question.recommended)
				? question.recommended
				: 0;
		const initialIndex = Math.max(0, Math.min(recommended, Math.max(0, question.options.length - 1)));
		for (;;) {
			const choice = await requestGuestString(
				getHost,
				{
					kind: "select",
					title: displayQuestion,
					options: [...baseOptions, ASK_OTHER_OPTION, ASK_CHAT_OPTION],
					initialIndex,
					selectionMarker: "radio",
					markableCount: question.options.length,
					helpText: "click selects  Cancel dismisses",
				},
				signal,
			);
			if (choice === undefined) return undefined;
			if (choice === ASK_CHAT_OPTION) return "chat";
			if (choice === ASK_OTHER_OPTION) {
				const input = await requestGuestString(getHost, { kind: "editor", title: customAnswerTitle }, signal);
				// Guest cancelled the editor: re-show the option list.
				if (input === undefined) continue;
				customInput = input;
			} else {
				selected.add(resolveGuestLabel(choice));
			}
			break;
		}
	}

	return {
		id: question.id,
		question: question.question,
		options: question.options.map(option => option.label),
		multi: question.multi ?? false,
		selectedOptions: question.options.map(option => option.label).filter(label => selected.has(label)),
		customInput,
	};
}

/**
 * Build the collab-bridging UI context. `getHost` is read per call so the
 * bridge can be installed before `CollabHost` construction completes (the
 * session host wires the tool UI before it starts the room).
 */
export function createCollabUiBridge(getHost: () => CollabHost | undefined): ExtensionUIContext {
	const stub = createStubUIContext();
	return {
		...stub,
		// The web composer presents the dialog as soon as it arrives; the
		// tool-level fallback timeout (`ask.timeout`) starts at call time.
		timeoutStartsOnPresentation: false,

		async askDialog(questions, dialogOptions): Promise<ExtensionAskDialogResult | undefined> {
			const signal = dialogOptions?.signal;
			const results: ExtensionAskDialogResultItem[] = [];
			for (const question of questions) {
				const result = await askGuestQuestion(getHost, question, signal);
				// undefined: denied, aborted, torn down, or guest cancel — AskTool
				// maps an undefined dialog result to a user cancellation.
				if (result === undefined) return undefined;
				if (result === "chat") return { kind: "chat" };
				results.push(result);
			}
			return { kind: "submit", results };
		},

		async select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			const displayLabels = disambiguateDisplayLabels(
				options.map(option => (typeof option === "string" ? option : option.label)),
				[],
			);
			const wireOptions: CollabUiSelectItem[] = options.map((option, index) =>
				typeof option === "string"
					? displayLabels[index]!
					: option.description?.trim()
						? { label: displayLabels[index]!, description: sanitizeCarriageReturns(option.description.trim()) }
						: { label: displayLabels[index]! },
			);
			const originalByDisplay = new Map<string, string>();
			options.forEach((option, index) => {
				originalByDisplay.set(displayLabels[index]!, typeof option === "string" ? option : option.label);
			});
			const choice = await requestGuestString(
				getHost,
				{
					kind: "select",
					title: boundAskTitle("", title),
					options: wireOptions,
					initialIndex: dialogOptions?.initialIndex,
					selectionMarker: dialogOptions?.selectionMarker,
					checkedIndices: dialogOptions?.checkedIndices === undefined ? undefined : [...dialogOptions.checkedIndices],
					markableCount: dialogOptions?.markableCount,
					helpText: dialogOptions?.helpText,
				},
				dialogOptions?.signal,
			);
			return choice === undefined ? undefined : (originalByDisplay.get(choice) ?? choice);
		},

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestGuestString(
				getHost,
				{
					kind: "editor",
					title: boundAskTitle("", title),
					prefill: prefill === undefined ? undefined : sanitizeCarriageReturns(prefill),
				},
				dialogOptions?.signal,
			);
		},
	};
}
