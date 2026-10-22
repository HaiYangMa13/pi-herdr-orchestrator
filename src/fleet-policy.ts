import type { Meta } from "./store.ts";

export type FleetVisibility = { showDone?: boolean; completedTtlMs?: number };

function completedTtl(options: FleetVisibility): number {
	const configured = options.completedTtlMs;
	return typeof configured === "number" && Number.isFinite(configured)
		? Math.max(0, configured) : 30_000;
}

/** Presentation only: never deletes results, mutates lifecycle, or closes a pane. */
export function showFleetRow(
	meta: Meta,
	state: string,
	live: boolean,
	now: number,
	options: FleetVisibility = {},
): boolean {
	if (state === "closed") return false;
	// A run that never started is not a failure to act on, and would otherwise pin an error
	// row to the strip forever; it expires like a success.
	if (state === "spawn_failed") {
		return Math.max(0, now - (meta.endedAt ?? meta.startedAt)) < completedTtl(options);
	}
	if (state !== "done") return true; // failures and questions require attention
	if (live) return true; // keepAlive or unfinished cleanup must remain visible
	if (options.showDone === false) return false;
	const ttl = completedTtl(options);
	// Persisted timestamps, not first render: restarting cannot revive old successes.
	const completed = meta.endedAt ?? meta.closedAt ?? meta.startedAt;
	return Math.max(0, now - completed) < ttl;
}

export function fleetRank(state: string): number {
	if (["blocked", "failed", "timeout", "no_result"].includes(state)) return 0;
	if (state === "spawn_failed") return 1;
	if (["running", "starting"].includes(state)) return 2;
	return 3;
}
