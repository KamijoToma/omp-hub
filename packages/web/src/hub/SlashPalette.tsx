/**
 * Slash-command palette: a listbox floating directly above the vendored
 * Composer. Presentation only — filtering lives in `commands.ts` and keyboard
 * handling in `SessionView`, which owns the composer wrapper.
 */
import type { ReactNode } from "react";
import type { CommandSpec } from "./commands";

export interface SlashPaletteProps {
	commands: readonly CommandSpec[];
	activeIndex: number;
	onHighlight(index: number): void;
	onRun(spec: CommandSpec): void;
}

export function SlashPalette({ commands, activeIndex, onHighlight, onRun }: SlashPaletteProps): ReactNode {
	return (
		<div className="hb-palette" role="listbox" aria-label="slash commands">
			{commands.map((spec, index) => (
				<button
					key={spec.name}
					type="button"
					role="option"
					aria-selected={index === activeIndex}
					className={`hb-palette-row${index === activeIndex ? " hb-palette-row-active" : ""}`}
					// Keep focus in the textarea: a focus move would dismiss the palette
					// before the click lands.
					onMouseDown={e => e.preventDefault()}
					onMouseEnter={() => onHighlight(index)}
					onClick={() => onRun(spec)}
				>
					<span className="hb-palette-name">/{spec.name}</span>
					<span className="hb-palette-desc">{spec.description}</span>
				</button>
			))}
		</div>
	);
}
