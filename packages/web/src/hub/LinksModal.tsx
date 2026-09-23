/**
 * `/collab` — collab links modal. `LinksSection` is shared with the settings
 * modal; the links themselves come from the session record the hub API
 * returned (`docs/protocol.md` §2 `session-ready`, §3 `SessionRecord.links`).
 */
import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { SessionRecord } from "./api";
import { copyText } from "./clipboard";
import { Modal } from "./Modal";

const FLASH_MS = 1600;

const LINK_FIELDS = [
	{ key: "full", label: "attach link", hint: "full write access" },
	{ key: "view", label: "view link", hint: "read-only" },
	{ key: "web", label: "web link", hint: "in-browser view" },
] as const;

export interface LinksSectionProps {
	record: SessionRecord | null;
}

export function LinksSection({ record }: LinksSectionProps): ReactNode {
	const [flash, setFlash] = useState<{ key: string; ok: boolean } | null>(null);

	// Copy feedback reverts on its own; a new copy restarts the countdown.
	useEffect(() => {
		if (!flash) return;
		const timer = setTimeout(() => setFlash(null), FLASH_MS);
		return () => clearTimeout(timer);
	}, [flash]);

	const links = record?.links;
	if (!links) return <p className="hb-empty">links appear once the session is live</p>;

	const label = (key: string, fallback: string): string => {
		if (flash?.key !== key) return fallback;
		return flash.ok ? "copied" : "copy failed";
	};

	return (
		<ul className="hb-links">
			{LINK_FIELDS.map(field => (
				<li className="hb-link-row" key={field.key}>
					<div className="hb-link-copy">
						<span className="hb-link-label">{field.label}</span>
						<span className="hb-link-url hb-mono" title={links[field.key]}>
							{links[field.key]}
						</span>
					</div>
					<button
						type="button"
						className="sh-btn"
						onClick={() => {
							void copyText(links[field.key]).then(ok => setFlash({ key: field.key, ok }));
						}}
						title={`copy the ${field.label} (${field.hint})`}
					>
						<Copy size={12} aria-hidden="true" />
						<span className="sh-btn-label">{label(field.key, "copy")}</span>
					</button>
				</li>
			))}
		</ul>
	);
}

export interface LinksModalProps {
	record: SessionRecord | null;
	onClose(): void;
}

export function LinksModal({ record, onClose }: LinksModalProps): ReactNode {
	return (
		<Modal title="Collab links" onClose={onClose}>
			<LinksSection record={record} />
			<p className="hb-card-note">anyone with the attach link can prompt this session; the view link is read-only.</p>
		</Modal>
	);
}
