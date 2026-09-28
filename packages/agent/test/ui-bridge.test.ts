/**
 * Collab UI bridge (ui-bridge.ts): maps `askDialog`/`select`/`editor` onto
 * `CollabHost.requestGuestUi` round trips. The host is a scripted double — the
 * request/response contract is what matters here, not a live relay; a real
 * child needs credentials and the full SDK to boot.
 *
 * Answer scripts queue guest responses in order; every request the bridge
 * raises is recorded with the draft and the signal it was handed.
 */

import { expect, test } from "bun:test";
import type { CollabHost, CollabGuestUiResult } from "@oh-my-pi/pi-coding-agent/collab/host";
import type { CollabUiRequestDraft, CollabUiResponseValue } from "@oh-my-pi/pi-wire";
import type { ExtensionAskDialogQuestion, ExtensionUIDialogOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { createCollabUiBridge } from "../src/ui-bridge";

type ScriptedAnswer = CollabUiResponseValue | { kind: "unavailable" };

class FakeHost {
	#answers: ScriptedAnswer[] = [];
	/** When set, `requestGuestUi` refuses (traffic gated / cap hit). */
	#refuse: { reason: "null" } | null = null;
	readonly requests: CollabUiRequestDraft[] = [];
	readonly signals: (AbortSignal | undefined)[] = [];

	constructor(...answers: ScriptedAnswer[]) {
		this.#answers = [...answers];
	}

	refuse(): void {
		this.#refuse = { reason: "null" };
	}

	requestGuestUi(draft: CollabUiRequestDraft, signal?: AbortSignal): Promise<CollabGuestUiResult> | null {
		if (this.#refuse) return null;
		this.requests.push(draft);
		this.signals.push(signal);
		const answer = this.#answers.length > 0 ? this.#answers.shift() : undefined;
		if (answer === undefined || typeof answer === "string") {
			return Promise.resolve({ kind: "answered", value: answer });
		}
		return Promise.resolve({ kind: "unavailable" });
	}
}

function host(fake: FakeHost): CollabHost {
	return fake as unknown as CollabHost;
}

function question(overrides?: Partial<ExtensionAskDialogQuestion>): ExtensionAskDialogQuestion {
	return {
		id: "deploy_target",
		question: "Which deploy target?",
		options: [{ label: "staging" }, { label: "production" }],
		recommended: 0,
		...overrides,
	};
}

const NO_OPTIONS: ExtensionUIDialogOptions | undefined = undefined;

test("single question: radio select with reserved actions, recommended initial", async () => {
	const fake = new FakeHost("production");
	const bridge = createCollabUiBridge(() => host(fake));
	const result = await bridge.askDialog!([question()], NO_OPTIONS);
	expect(result).toEqual({
		kind: "submit",
		results: [
			{
				id: "deploy_target",
				question: "Which deploy target?",
				options: ["staging", "production"],
				multi: false,
				selectedOptions: ["production"],
				customInput: undefined,
			},
		],
	});
	const request = fake.requests[0];
	expect(request.kind).toBe("select");
	if (request.kind !== "select") return;
	expect(request.title).toBe("Which deploy target?");
	expect(request.selectionMarker).toBe("radio");
	expect(request.initialIndex).toBe(0);
	expect(request.markableCount).toBe(2);
	expect(request.options).toEqual(["staging", "production", "Other (type your own)", "Chat about this"]);
});

test("multi question: toggles re-request with checked state, Next gates submit", async () => {
	const fake = new FakeHost("staging", "Next →");
	const bridge = createCollabUiBridge(() => host(fake));
	const result = await bridge.askDialog!([question({ multi: true, recommended: undefined })], NO_OPTIONS);
	expect(result).toEqual({
		kind: "submit",
		results: [
			{
				id: "deploy_target",
				question: "Which deploy target?",
				options: ["staging", "production"],
				multi: true,
				selectedOptions: ["staging"],
				customInput: undefined,
			},
		],
	});
	expect(fake.requests).toHaveLength(2);
	const first = fake.requests[0];
	const second = fake.requests[1];
	if (first?.kind !== "select" || second?.kind !== "select") return expect.unreachable();
	// No answer yet: Next is withheld so an empty multi cannot be submitted.
	expect(first.options).not.toContain("Next →");
	expect(first.checkedIndices).toEqual([]);
	// After the toggle: Next appears and the checked state mirrors the pick.
	expect(second.options).toContain("Next →");
	expect(second.checkedIndices).toEqual([0]);
});

test("Other routes through an editor round trip into customInput", async () => {
	const fake = new FakeHost("Other (type your own)", "ship it friday");
	const bridge = createCollabUiBridge(() => host(fake));
	const result = await bridge.askDialog!([question({ recommended: undefined })], NO_OPTIONS);
	expect(result).toEqual({
		kind: "submit",
		results: [
			{
				id: "deploy_target",
				question: "Which deploy target?",
				options: ["staging", "production"],
				multi: false,
				selectedOptions: [],
				customInput: "ship it friday",
			},
		],
	});
	expect(fake.requests[1]?.kind).toBe("editor");
	expect(fake.requests[1]?.kind === "editor" && fake.requests[1].title.startsWith("Custom answer: ")).toBe(true);
});

test("Chat about this short-circuits to a chat result", async () => {
	const fake = new FakeHost("Chat about this");
	const bridge = createCollabUiBridge(() => host(fake));
	const result = await bridge.askDialog!([question()], NO_OPTIONS);
	expect(result).toEqual({ kind: "chat" });
});

test("guest cancellation and unavailable teardown deny the dialog", async () => {
	const cancelled = new FakeHost(undefined);
	expect(
		await createCollabUiBridge(() => host(cancelled)).askDialog!([question()], NO_OPTIONS),
	).toBeUndefined();

	const unavailable = new FakeHost({ kind: "unavailable" });
	expect(
		await createCollabUiBridge(() => host(unavailable)).askDialog!([question()], NO_OPTIONS),
	).toBeUndefined();

	const refused = new FakeHost();
	refused.refuse();
	expect(
		await createCollabUiBridge(() => host(refused)).askDialog!([question()], NO_OPTIONS),
	).toBeUndefined();
	expect(refused.requests).toHaveLength(0);
});

test("no collab host: deny without constructing requests", async () => {
	const fake = new FakeHost("staging");
	const bridge = createCollabUiBridge(() => undefined);
	expect(await bridge.askDialog!([question()], NO_OPTIONS)).toBeUndefined();
	expect(await bridge.select("pick", ["a", "b"], NO_OPTIONS)).toBeUndefined();
	expect(await bridge.editor("text", undefined, NO_OPTIONS)).toBeUndefined();
	expect(fake.requests).toHaveLength(0);
});

test("caller abort signal is forwarded so CollabHost settles the request", async () => {
	const fake = new FakeHost("staging");
	const bridge = createCollabUiBridge(() => host(fake));
	const controller = new AbortController();
	await bridge.askDialog!([question()], { signal: controller.signal });
	expect(fake.signals[0]).toBe(controller.signal);
});

test("labels colliding with reserved actions are disambiguated on the wire and mapped back", async () => {
	// AskTool rejects model labels colliding with reserved runtime labels
	// outright, so this only reaches the bridge via non-ask select surfaces;
	// the mapping must still round-trip the original label.
	const fake = new FakeHost("Other (type your own) (2)");
	const bridge = createCollabUiBridge(() => host(fake));
	const result = await bridge.askDialog!(
		[question({ options: [{ label: "x" }, { label: "Other (type your own)" }], recommended: undefined })],
		NO_OPTIONS,
	);
	const request = fake.requests[0];
	if (request?.kind !== "select") return expect.unreachable();
	expect(request.options).toEqual(["x", "Other (type your own) (2)", "Other (type your own)", "Chat about this"]);
	expect(result).toEqual({
		kind: "submit",
		results: [
			{
				id: "deploy_target",
				question: "Which deploy target?",
				options: ["x", "Other (type your own)"],
				multi: false,
				selectedOptions: ["Other (type your own)"],
				customInput: undefined,
			},
		],
	});
});

test("plain select mirrors options and maps the answered display label back", async () => {
	const fake = new FakeHost("y");
	const bridge = createCollabUiBridge(() => host(fake));
	const picked = await bridge.select("mode", [{ label: "x", description: "fast" }, "y"], NO_OPTIONS);
	expect(picked).toBe("y");
	const request = fake.requests[0];
	if (request?.kind !== "select") return expect.unreachable();
	expect(request.options).toEqual([
		{ label: "x", description: "fast" },
		"y",
	]);
	expect(fake.signals[0]).toBeUndefined();
});

test("editor round trip returns the guest text", async () => {
	const fake = new FakeHost("edited body");
	const bridge = createCollabUiBridge(() => host(fake));
	expect(await bridge.editor("note", "original", NO_OPTIONS)).toBe("edited body");
	const request = fake.requests[0];
	expect(request).toEqual({ kind: "editor", title: "note", prefill: "original" });
});

test("stub members keep default-deny headless semantics", async () => {
	const bridge = createCollabUiBridge(() => new FakeHost() as unknown as CollabHost);
	expect(await bridge.confirm("title", "body")).toBe(false);
	expect(await bridge.input("title")).toBeUndefined();
});
