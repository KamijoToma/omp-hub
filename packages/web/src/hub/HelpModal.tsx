/**
 * `/help` — the §6 command table, straight from {@link COMMANDS} so the list
 * can never drift from the routing table.
 */
import type { ReactNode } from "react";
import { COMMANDS } from "./commands";
import { Modal } from "./Modal";

export interface HelpModalProps {
	onClose(): void;
}

export function HelpModal({ onClose }: HelpModalProps): ReactNode {
	return (
		<Modal title="Commands" onClose={onClose}>
			<ul className="hb-cmd-list">
				{COMMANDS.map(spec => (
					<li className="hb-cmd-row" key={spec.name}>
						<span className="hb-cmd-name">/{spec.name}</span>
						<span className="hb-cmd-desc">{spec.description}</span>
					</li>
				))}
			</ul>
			<p className="hb-card-note">
				text starting with <code>/</code> is handled here and never sent to the agent.
			</p>
		</Modal>
	);
}
