/**
 * Full-screen in-page image viewer, portaled to document.body.
 *
 * Replaces the old open-a-new-tab `blob:` flow: clicking a tool-result
 * thumbnail overlays the viewer on the current page, keeping the session,
 * composer, and scroll position intact. Pure React + DOM with self-contained
 * chrome (the `--tv-*` tokens are scoped to `.tv-card`, which a portal
 * escapes), so it works identically in the hub session page, the guest page,
 * and `<omp-tool-view>` HTML exports.
 *
 * Fit-to-screen by default; click the image (or the toolbar button) toggles
 * 1:1 size with drag-to-pan. Esc / backdrop click close, ←/→ move between
 * images of the same result.
 */
import { ChevronLeft, ChevronRight, Download, Maximize2, Minimize2, X } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ToolResultImage } from "./types";

const MIME_EXT: Record<string, string> = {
	"image/gif": "gif",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/svg+xml": "svg",
	"image/webp": "webp",
};

/** Drags under this many pixels count as clicks (zoom toggle), not pans. */
const CLICK_SLOP = 4;

function fileExt(mimeType: string): string {
	return MIME_EXT[mimeType.toLowerCase().split(";")[0] ?? ""] ?? "bin";
}

export interface ImageLightboxProps {
	images: readonly ToolResultImage[];
	/** Zero-based image shown first. */
	initialIndex: number;
	onClose(): void;
}

export function ImageLightbox({ images, initialIndex, onClose }: ImageLightboxProps): ReactNode {
	const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), Math.max(images.length - 1, 0)));
	const [zoomed, setZoomed] = useState(false);
	const stageRef = useRef<HTMLDivElement | null>(null);
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const drag = useRef<{ x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
	const img = images[index];

	// Focus the viewer, lock page scroll behind it, restore on unmount.
	useEffect(() => {
		closeRef.current?.focus();
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => {
			document.body.style.overflow = prevOverflow;
		};
	}, []);

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				// Capture phase: close the viewer before the composer palette sees Esc.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			} else if (e.key === "ArrowLeft" && index > 0) {
				setIndex(index - 1);
				setZoomed(false);
			} else if (e.key === "ArrowRight" && index < images.length - 1) {
				setIndex(index + 1);
				setZoomed(false);
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [index, images.length, onClose]);

	if (!img) return null;

	const navigate = (next: number): void => {
		setIndex(next);
		setZoomed(false);
	};

	const download = (): void => {
		try {
			const bin = atob(img.data);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const url = URL.createObjectURL(new Blob([bytes], { type: img.mimeType }));
			const a = document.createElement("a");
			a.href = url;
			a.download = `image-${index + 1}.${fileExt(img.mimeType)}`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch {
			// Undecodable image data — nothing sensible to download.
		}
	};

	// One pointer path for both modes: a clean click toggles zoom, a drag pans
	// (only meaningful at 1:1 where the stage overflows).
	const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
		const stage = stageRef.current;
		if (!stage) return;
		drag.current = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false };
		stage.setPointerCapture(e.pointerId);
	};
	const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
		const d = drag.current;
		const stage = stageRef.current;
		if (!d || !stage) return;
		const dx = e.clientX - d.x;
		const dy = e.clientY - d.y;
		if (!d.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
		if (!zoomed) return;
		d.moved = true;
		stage.scrollLeft = d.left - dx;
		stage.scrollTop = d.top - dy;
	};
	const onPointerUp = (): void => {
		const d = drag.current;
		drag.current = null;
		if (d && !d.moved) setZoomed(v => !v);
	};

	return createPortal(
		<div
			className="tv-lightbox"
			role="dialog"
			aria-modal="true"
			aria-label={`Image ${index + 1} of ${images.length}`}
			onClick={onClose}
		>
			<div className="tv-lightbox-bar" onClick={e => e.stopPropagation()}>
				<span className="tv-lightbox-count">{images.length > 1 ? `${index + 1} / ${images.length}` : ""}</span>
				<div className="tv-lightbox-actions">
					<button
						type="button"
						className="tv-lightbox-btn"
						title={zoomed ? "fit to screen (click image)" : "actual size (click image)"}
						onClick={() => setZoomed(v => !v)}
					>
						{zoomed ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
					</button>
					<button type="button" className="tv-lightbox-btn" title="download" onClick={download}>
						<Download size={14} aria-hidden="true" />
					</button>
					<button
						ref={closeRef}
						type="button"
						className="tv-lightbox-btn"
						title="close (Esc)"
						onClick={onClose}
					>
						<X size={14} aria-hidden="true" />
					</button>
				</div>
			</div>
			{images.length > 1 && index > 0 && (
				<button
					type="button"
					className="tv-lightbox-nav tv-lightbox-nav--prev"
					title="previous (←)"
					onClick={e => {
						e.stopPropagation();
						navigate(index - 1);
					}}
				>
					<ChevronLeft size={20} aria-hidden="true" />
				</button>
			)}
			{images.length > 1 && index < images.length - 1 && (
				<button
					type="button"
					className="tv-lightbox-nav tv-lightbox-nav--next"
					title="next (→)"
					onClick={e => {
						e.stopPropagation();
						navigate(index + 1);
					}}
				>
					<ChevronRight size={20} aria-hidden="true" />
				</button>
			)}
			<div
				ref={stageRef}
				className={`tv-lightbox-stage${zoomed ? " tv-lightbox-stage--zoomed" : ""}`}
				onClick={e => e.stopPropagation()}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
			>
				<img
					className="tv-lightbox-img"
					src={`data:${img.mimeType};base64,${img.data}`}
					alt={`image ${index + 1} of ${images.length}`}
					draggable={false}
				/>
			</div>
		</div>,
		document.body,
	);
}
