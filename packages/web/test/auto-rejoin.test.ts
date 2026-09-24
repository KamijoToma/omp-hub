/**
 * Auto-rejoin policy: an ended collab client re-joins with capped backoff
 * while the polled registry still reports the session live (the relay's fatal
 * "no such room" is transient inside the hub), and the end card only returns
 * once the registry stops saying live.
 */
import { describe, expect, test } from "bun:test";
import { rejoinDelayMs, shouldAutoRejoin } from "../src/hub/auto-rejoin";

describe("rejoinDelayMs", () => {
	test("doubles per attempt and caps at 15s", () => {
		expect(rejoinDelayMs(0)).toBe(1_000);
		expect(rejoinDelayMs(1)).toBe(2_000);
		expect(rejoinDelayMs(2)).toBe(4_000);
		expect(rejoinDelayMs(4)).toBe(15_000);
		expect(rejoinDelayMs(50)).toBe(15_000);
	});

	test("clamps negative attempts to the base delay", () => {
		expect(rejoinDelayMs(-3)).toBe(1_000);
	});
});

describe("shouldAutoRejoin", () => {
	test("only an ended phase with a live registry record re-joins", () => {
		expect(shouldAutoRejoin("ended", true)).toBe(true);
		expect(shouldAutoRejoin("ended", false)).toBe(false);
		expect(shouldAutoRejoin("live", true)).toBe(false);
		expect(shouldAutoRejoin("reconnecting", true)).toBe(false);
		expect(shouldAutoRejoin("connecting", true)).toBe(false);
		expect(shouldAutoRejoin("waiting", true)).toBe(false);
	});
});
