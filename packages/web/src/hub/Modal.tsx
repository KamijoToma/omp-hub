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
	/**
	 * Returning true consumes Esc: the owner handles the key itself (e.g. the
	 * model palette's clear-query → close ladder) and the modal stays open.
	 */
	onEscape?: () => boolean;
}

export function Modal({ title, onClose, children, leading, onEscape }: ModalProps): ReactNode {
	// Capture phase: Esc closes the dialog before the composer's palette sees it.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key !== "Escape") return;
			if (onEscape?.()) return;
			e.preventDefault();
			e.stopPropagation();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [onClose, onEscape]);

	// Restore focus to whatever opened the dialog (a11y: dialogs must return focus).
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		return () => previous?.focus();
	}, []);

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
