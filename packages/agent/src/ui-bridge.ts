/**
 * Headless extension UI: fleet controllers and writable collab guests share
 * each pending question. Whoever answers first settles it; the other surface
 * receives cancellation. A missing guest never cancels a fleet request.
 */
import { randomUUID } from "node:crypto";

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

export interface FleetPendingInput {
	requestId: string;
	kind: "select" | "editor";
	title: string;
	options?: CollabUiSelectItem[];
	prefill?: string;
}

export interface FleetInputBridge extends ExtensionUIContext {
	getPendingInput(): FleetPendingInput[];
	answerInput(requestId: string, answer: string): boolean;
}

type RequestString = (request: CollabUiRequestDraft, signal?: AbortSignal) => Promise<string | undefined>;

/** First valid controller or writable guest answer wins, even without guests. */
function createInputRequests(
	getHost: () => CollabHost | undefined,
	onEvent?: (event: { kind: "input_required" | "input_resolved"; requestId: string }) => void,
): { request: RequestString; pending: () => FleetPendingInput[]; answer: (requestId: string, answer: string) => boolean } {
	const pending = new Map<string, { input: FleetPendingInput; settle: (answer?: string) => void }>();
	return {
		pending: () => [...pending.values()].map(entry => entry.input),
		answer(requestId, answer) {
			const entry = pending.get(requestId);
			if (!entry || typeof answer !== "string") return false;
			if (entry.input.kind === "select" &&
				!entry.input.options?.some(option => (typeof option === "string" ? option : option.label) === answer)) return false;
			entry.settle(answer);
			return true;
		},
		async request(draft, signal) {
			if (signal?.aborted) return undefined;
			const requestId = randomUUID();
			const input: FleetPendingInput = {
				requestId, kind: draft.kind, title: draft.title,
				...(draft.kind === "select" ? { options: draft.options } : { prefill: draft.prefill }),
			};
			const guestAbort = new AbortController();
			let settled = false;
			let resolveAnswer!: (answer?: string) => void;
			const answerPromise = new Promise<string | undefined>(resolve => { resolveAnswer = resolve; });
			const settle = (answer?: string): void => {
				if (settled) return;
				settled = true;
				pending.delete(requestId);
				resolveAnswer(answer);
			};
			pending.set(requestId, { input, settle });
			const onAbort = (): void => settle(undefined);
			signal?.addEventListener("abort", onAbort, { once: true });
			let announced = false;
			try {
				const remote = getHost()?.requestGuestUi(draft, guestAbort.signal);
				if (remote) {
					announced = true;
					onEvent?.({ kind: "input_required", requestId });
					void remote.then(result =>
						settle(result.kind === "answered" && typeof result.value === "string" ? result.value : undefined),
						() => settle(undefined));
				} else {
					// No room/traffic gate: preserve the headless default-deny contract.
					settle(undefined);
				}
				return await answerPromise;
			} finally {
				pending.delete(requestId);
				signal?.removeEventListener("abort", onAbort);
				guestAbort.abort();
				if (announced) onEvent?.({ kind: "input_resolved", requestId });
			}
		},
	};
}

/** Ask one question through the guests (TUI controller's `#runGuestAskQuestion`). */
async function askGuestQuestion(
	request: RequestString,
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
			const choice = await request(
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
				const input = await request({ kind: "editor", title: customAnswerTitle }, signal);
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
			const choice = await request(
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
				const input = await request({ kind: "editor", title: customAnswerTitle }, signal);
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
export function createCollabUiBridge(
	getHost: () => CollabHost | undefined,
	onEvent?: (event: { kind: "input_required" | "input_resolved"; requestId: string }) => void,
): FleetInputBridge {
	const stub = createStubUIContext();
	const inputs = createInputRequests(getHost, onEvent);
	const request = inputs.request;
	return {
		...stub,
		getPendingInput: inputs.pending,
		answerInput: inputs.answer,
		// The web composer presents the dialog as soon as it arrives; the
		// tool-level fallback timeout (`ask.timeout`) starts at call time.
		timeoutStartsOnPresentation: false,

		async askDialog(questions, dialogOptions): Promise<ExtensionAskDialogResult | undefined> {
			const signal = dialogOptions?.signal;
			const results: ExtensionAskDialogResultItem[] = [];
			for (const question of questions) {
				const result = await askGuestQuestion(request, question, signal);
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
			const choice = await request(
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
			return request(
				{
					kind: "editor",
					title: boundAskTitle("", title),
					prefill: prefill === undefined ? undefined : sanitizeCarriageReturns(prefill),
				},
				dialogOptions?.signal,
			);
		},
		async confirm(title, message, dialogOptions) {
			const choice = await request({ kind: "select", title: boundAskTitle(`${title}: `, message), options: ["Yes", "No"] }, dialogOptions?.signal);
			return choice === "Yes";
		},
		async input(title, placeholder, dialogOptions) {
			return request({ kind: "editor", title: boundAskTitle("", title), prefill: placeholder }, dialogOptions?.signal);
		},
	};
}
