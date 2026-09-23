/**
 * Shared shell for the hub's slash-command dialogs: fixed backdrop, Esc or
 * backdrop close, title bar, scrollable body. Centered card on desktop, bottom
 * sheet on phones (≤640px) — the breakpoint and tokens come from hub.css.
 */
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect } from "react";

export interface ModalProps {
	title: string;
	onClose(): void;
	children: ReactNode;
	/** Header slot before the title (e.g. a back button inside a multi-view modal). */
	leading?: ReactNode;
}

export function Modal({ title, onClose, children, leading }: ModalProps): ReactNode {
	// Capture phase: Esc closes the dialog before the composer's palette sees it.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [onClose]);

	return (
		<div className="hb-modal-backdrop" onClick={onClose}>
			<div
				className="hb-modal"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				onClick={e => e.stopPropagation()}
			>
				<div className="hb-modal-head">
					{leading}
					<h2 className="hb-modal-title">{title}</h2>
					<button type="button" className="sh-btn hb-modal-close" onClick={onClose} title="close (Esc)">
						<X size={13} aria-hidden="true" />
						<span className="sh-btn-label">Close</span>
					</button>
				</div>
				<div className="hb-modal-body">{children}</div>
			</div>
		</div>
	);
}
