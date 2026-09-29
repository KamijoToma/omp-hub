/** Headless UI bridge behavioral tests: guest/controller answer races and ask steps. */

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
});

test("controller can answer without a guest; pending input resolves and events correlate", async () => {
	const events: Array<{ kind: string; requestId: string }> = [];
	const emptyRoom = { requestGuestUi: () => new Promise<CollabGuestUiResult>(() => {}) } as unknown as CollabHost;
	const bridge = createCollabUiBridge(() => emptyRoom, event => events.push(event));
	const result = bridge.askDialog!([question()], NO_OPTIONS);
	const [pending] = bridge.getPendingInput();
	expect(pending?.kind).toBe("select");
	expect(pending?.options).toEqual(["staging", "production", "Other (type your own)", "Chat about this"]);
	expect(bridge.answerInput(pending!.requestId, "missing")).toBe(false);
	expect(bridge.answerInput(pending!.requestId, "production")).toBe(true);
	expect((await result)?.kind).toBe("submit");
	expect(bridge.getPendingInput()).toEqual([]);
	expect(bridge.answerInput(pending!.requestId, "staging")).toBe(false);
	expect(events).toEqual([
		{ kind: "input_required", requestId: pending!.requestId },
		{ kind: "input_resolved", requestId: pending!.requestId },
	]);
});

test("controller answer cancels guests; a guest answer rejects stale controller answers", async () => {
	let aborted = false;
	let guestResolve!: (value: CollabGuestUiResult) => void;
	const guest = {
		requestGuestUi(_draft: CollabUiRequestDraft, signal?: AbortSignal) {
			signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
			return new Promise<CollabGuestUiResult>(resolve => { guestResolve = resolve; });
		},
	} as unknown as CollabHost;
	const bridge = createCollabUiBridge(() => guest);
	const choosing = bridge.select("pick", ["yes", "no"]);
	const requestId = bridge.getPendingInput()[0]!.requestId;
	expect(bridge.answerInput(requestId, "yes")).toBe(true);
	expect(await choosing).toBe("yes");
	expect(aborted).toBe(true);
	const another = bridge.select("pick", ["yes", "no"]);
	const nextId = bridge.getPendingInput()[0]!.requestId;
	guestResolve({ kind: "answered", value: "no" });
	expect(await another).toBe("no");
	expect(bridge.answerInput(nextId, "yes")).toBe(false);
});

test("without a live collab room the headless host denies instead of stranding an ask", async () => {
	const bridge = createCollabUiBridge(() => undefined);
	expect(await bridge.askDialog!([question()], NO_OPTIONS)).toBeUndefined();
	expect(bridge.getPendingInput()).toEqual([]);
	const fake = new FakeHost();
	fake.refuse();
	expect(await createCollabUiBridge(() => host(fake)).editor("blocked")).toBeUndefined();
});

test("caller abort settles a pending guest request", async () => {
	const controller = new AbortController();
	const guest = { requestGuestUi: () => new Promise<CollabGuestUiResult>(() => {}) } as unknown as CollabHost;
	const bridge = createCollabUiBridge(() => guest);
	const result = bridge.editor("text", undefined, { signal: controller.signal });
	expect(bridge.getPendingInput()).toHaveLength(1);
	controller.abort();
	expect(await result).toBeUndefined();
	expect(bridge.getPendingInput()).toHaveLength(0);
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
	expect(fake.signals[0]).toBeInstanceOf(AbortSignal);
});

test("editor round trip returns the guest text", async () => {
	const fake = new FakeHost("edited body");
	const bridge = createCollabUiBridge(() => host(fake));
	expect(await bridge.editor("note", "original", NO_OPTIONS)).toBe("edited body");
	const request = fake.requests[0];
	expect(request).toEqual({ kind: "editor", title: "note", prefill: "original" });
});

test("confirm and input use the same guest surface", async () => {
	const bridge = createCollabUiBridge(() => host(new FakeHost("Yes")));
	expect(await bridge.confirm("deploy", "now?")).toBe(true);
	const text = createCollabUiBridge(() => host(new FakeHost("manual"))).input("reason");
	expect(await text).toBe("manual");
});
