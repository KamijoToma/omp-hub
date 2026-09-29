/**
 * Settings gateway (protocol §2 `get-settings` / `set-setting`, 0.9.0+): the
 * hub-curated allowlist of the SDK's typed setting descriptors, projected to
 * JSON-safe wire rows, plus session-scoped runtime overrides (`Setting.override`)
 * that never touch `settings.json` and die with the process.
 *
 * Static SDK imports here are safe: this module is loaded lazily by
 * session-host `run()` after the config boundary, like the rest of the SDK.
 */

import { lookup, type AnySetting } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
// Importing the owning modules registers their descriptors in the registry,
// so `lookup` below resolves deterministically regardless of import order.
import "@oh-my-pi/pi-coding-agent/session/context-settings";
import "@oh-my-pi/pi-coding-agent/session/settings";
import "@oh-my-pi/pi-coding-agent/advisor/settings";
import "@oh-my-pi/pi-coding-agent/edit/settings";
import "@oh-my-pi/pi-coding-agent/exec/settings";
import "@oh-my-pi/pi-coding-agent/goals/settings";
import "@oh-my-pi/pi-coding-agent/export/ttsr-settings";
import { errorMessage } from "./log";

/** One allowlisted setting row on the wire (protocol §2 `SettingWire`). */
export interface SettingWire {
	id: string;
	value: unknown;
	defaultValue: unknown;
	type: string;
	values?: string[];
	tab?: string;
	group?: string;
	description: string;
	configured: boolean;
	overridden: boolean;
}

/**
 * Hub-curated setting ids (protocol §2 0.9.0+). Session-behavior knobs only:
 * the model registry, provider credentials, and other never-expose surfaces
 * are deliberately absent. Ids the installed SDK registry cannot resolve are
 * dropped at projection time, so retiring an id upstream never breaks this.
 */
const SETTING_ALLOWLIST: Record<string, true> = {
	// Compaction
	"compaction.enabled": true,
	"compaction.thresholdPercent": true,
	"compaction.thresholdTokens": true,
	"compaction.idleEnabled": true,
	"compaction.idleThresholdTokens": true,
	"compaction.idleTimeoutSeconds": true,
	"compaction.asyncEnabled": true,
	"compaction.autoContinue": true,
	// Thinking
	"externalThinking": true,
	// Loop guard
	"model.loopGuard.enabled": true,
	// Editing
	"edit.mode": true,
	"edit.fuzzyMatch": true,
	"edit.fuzzyThreshold": true,
	// Bash
	"bash.enabled": true,
	"bash.allowCompoundCommands": true,
	"bash.autoBackground.enabled": true,
	"bash.patterns": true,
	"bashInterceptor.enabled": true,
	// Advanced modes
	"prewalk.enabled": true,
	"advisor.enabled": true,
	"goal.continuationModes": true,
	// To-summarize-to-review
	"ttsr.enabled": true,
	"ttsr.judge": true,
	"ttsr.contextMode": true,
	"ttsr.interruptMode": true,
} satisfies Record<string, true>;

/**
 * Runtime overrides applied per isolated Settings instance. There is no
 * registry introspection for "is this id overridden", and one process hosts
 * exactly one session, so a WeakMap keyed on the Settings instance is the
 * authoritative record for the wire's `overridden` flag.
 */
const appliedOverrides = new WeakMap<Settings, Set<string>>();

function overrideIds(settings: Settings): Set<string> {
	let ids = appliedOverrides.get(settings);
	if (!ids) {
		ids = new Set<string>();
		appliedOverrides.set(settings, ids);
	}
	return ids;
}

function allowlisted(id: string): AnySetting | undefined {
	if (SETTING_ALLOWLIST[id] !== true) return undefined;
	return lookup(id);
}

/** JSON-safe default: the descriptor default, `null` when it has none. */
function wireDefault(setting: AnySetting): unknown {
	const value = setting.default;
	return value === undefined ? null : JSON.parse(JSON.stringify(value)) as unknown;
}

/** One allowlisted descriptor → wire row for `settings`. */
function wireRow(setting: AnySetting, settings: Settings): SettingWire {
	const ui = setting.ui;
	const row: SettingWire = {
		id: setting.id,
		value: JSON.parse(JSON.stringify(setting.get(settings))) as unknown,
		defaultValue: wireDefault(setting),
		type: setting.type,
		description: setting.ui?.description ?? "",
		configured: settings.isConfigured(setting),
		overridden: overrideIds(settings).has(setting.id),
	};
	const values = setting.enumValues;
	if (values) row.values = [...values];
	if (ui?.tab) row.tab = ui.tab;
	if (ui?.group) row.group = ui.group;
	return row;
}

/** `get-settings` payload: every allowlisted descriptor, declaration order. */
export function settingsWire(settings: Settings): SettingWire[] {
	const rows: SettingWire[] = [];
	for (const id of Object.keys(SETTING_ALLOWLIST)) {
		const setting = lookup(id);
		if (setting) rows.push(wireRow(setting, settings));
	}
	return rows;
}

/**
 * `set-setting`: apply (or with `value: null`, clear) a session-scoped runtime
 * override on an allowlisted descriptor, then return the fresh wire row.
 * Caller input is validated against the descriptor type before the override,
 * and normalize/validate rejections surface as stable caller-readable errors.
 */
export function applySettingOverride(settings: Settings, settingId: string, value: unknown): SettingWire {
	const setting = allowlisted(settingId);
	if (!setting) throw new Error(`unknown or disallowed setting: ${settingId}`);
	if (value !== null) {
		const problem = typeMismatch(setting, value);
		if (problem) throw new Error(`setting "${settingId}" expects ${problem}`);
		try {
			setting.override(settings, value);
		} catch (err) {
			throw new Error(`setting "${settingId}" rejected value: ${errorMessage(err)}`);
		}
		overrideIds(settings).add(settingId);
	} else {
		setting.override(settings, undefined);
		overrideIds(settings).delete(settingId);
	}
	return wireRow(setting, settings);
}

/** Human reason the value does not fit the descriptor, or null when it fits. */
function typeMismatch(setting: AnySetting, value: unknown): string | null {
	switch (setting.type) {
		case "boolean":
			return typeof value === "boolean" ? null : "a boolean";
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? null : "a finite number";
		case "string":
			return typeof value === "string" ? null : "a string";
		case "enum": {
			if (typeof value !== "string") return `one of: ${setting.enumValues?.join(", ")}`;
			return setting.enumValues?.includes(value) ? null : `one of: ${setting.enumValues?.join(", ")}`;
		}
		case "array":
			return Array.isArray(value) ? null : "an array";
		case "record":
			return isPlainRecord(value) ? null : "an object";
		default:
			return `a value of type ${setting.type}`;
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

