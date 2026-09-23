import { Square } from "lucide-react";
import type { ReactNode } from "react";
import type { PendingSteer } from "./steering-queue";

export interface SteeringQueueBarProps {
	pending: readonly PendingSteer[];
	/** Host-queued messages not submitted from this guest. */
	extraQueued: number;
	/** Abort the current turn so the host delivers the queued messages now. */
	onFlush(): void;
}

/**
 * Queued steering messages shown above the composer (TUI pending-messages bar
 * parity). Delivery happens host-side; Enter on an empty editor or the
 * interrupt button aborts the turn so the queue drains immediately.
 */
export function SteeringQueueBar({ pending, extraQueued, onFlush }: SteeringQueueBarProps): ReactNode {
	if (pending.length === 0) return null;
	return (
		<div className="hb-steer" role="status">
			<div className="hb-steer-list">
				{pending.map((item, index) => (
					<div key={`${item.cursor}-${index}`} className="hb-steer-item">
						<span className="hb-steer-marker" aria-hidden="true">
							→
						</span>
						<span className="hb-steer-text">{item.text}</span>
					</div>
				))}
				{extraQueued > 0 && <div className="hb-steer-item hb-steer-extra">…and {extraQueued} more queued on the host</div>}
			</div>
			<div className="hb-steer-meta">
				<span className="hb-steer-hint">
					steering — the agent picks this up at the next tool call or when the turn ends; Enter on an
					empty editor interrupts now
				</span>
				<button
					type="button"
					className="sh-btn sh-btn-stop"
					onClick={onFlush}
					title="interrupt the turn and deliver the queued messages now"
				>
					<Square size={11} /> <span className="sh-btn-label">Interrupt &amp; send</span>
				</button>
			</div>
		</div>
	);
}
