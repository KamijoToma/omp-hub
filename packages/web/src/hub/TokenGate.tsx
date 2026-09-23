/**
 * Full-screen token gate: shared hub token + display name, both stored in
 * localStorage. The token is validated with one authenticated request before
 * the hub pages mount, so a bad token surfaces here instead of as a scatter of
 * failed polls.
 */
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { ThemeToggle } from "../components/shell/ThemeToggle";
import { errorText, getDisplayName, getMachines, getToken, HubApiError, setDisplayName, setToken, clearToken } from "./api";

export interface TokenGateProps {
	onReady(token: string): void;
}

export function TokenGate({ onReady }: TokenGateProps): ReactNode {
	const [token, setTokenInput] = useState(() => getToken() ?? "");
	const [name, setName] = useState(() => getDisplayName());
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
		e.preventDefault();
		const trimmed = token.trim();
		if (!trimmed) {
			setError("enter the hub token");
			return;
		}
		setBusy(true);
		setError(null);
		setToken(trimmed);
		try {
			await getMachines();
		} catch (err) {
			clearToken();
			setBusy(false);
			setError(err instanceof HubApiError && err.status === 401 ? "unauthorized — check the hub token" : errorText(err));
			return;
		}
		setDisplayName(name);
		setBusy(false);
		onReady(trimmed);
	};

	return (
		<div className="sh-connect">
			<form className="sh-connect-card" onSubmit={submit}>
				<div className="sh-connect-head">
					<div className="sh-lockup">
						<span className="sh-lockup-mark" aria-hidden="true" />
						<span className="sh-lockup-pi">π</span> omp hub
					</div>
					<ThemeToggle />
				</div>
				<div className="sh-connect-sub">your machines, live in your browser</div>
				<label className="sh-field">
					<span className="sh-field-label">hub token</span>
					<input
						className="sh-input sh-input-mono"
						type="password"
						value={token}
						onChange={e => setTokenInput(e.target.value)}
						placeholder="HUB_TOKEN"
						spellCheck={false}
						autoComplete="off"
						autoFocus
					/>
					<span className="sh-field-hint">the token the hub was started with</span>
				</label>
				<label className="sh-field">
					<span className="sh-field-label">display name</span>
					<input
						className="sh-input"
						type="text"
						value={name}
						onChange={e => setName(e.target.value)}
						placeholder="guest"
						spellCheck={false}
						autoComplete="off"
						maxLength={32}
					/>
				</label>
				{error && (
					<div className="sh-connect-error" role="alert">
						{error}
					</div>
				)}
				<button className="sh-btn sh-btn-primary sh-connect-submit" type="submit" disabled={busy}>
					{busy ? "checking…" : "Open hub"}
				</button>
			</form>
		</div>
	);
}
