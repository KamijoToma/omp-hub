/**
 * Clipboard write for the hub pages. `navigator.clipboard` needs a secure
 * context and a focused document, so a rejected call falls back to the legacy
 * hidden-textarea copy.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// blocked (insecure context, no focus): fall through to execCommand
	}
	try {
		const el = document.createElement("textarea");
		el.value = text;
		el.setAttribute("readonly", "");
		el.style.position = "fixed";
		el.style.opacity = "0";
		document.body.appendChild(el);
		el.select();
		const ok = document.execCommand("copy");
		el.remove();
		return ok;
	} catch {
		return false;
	}
}
