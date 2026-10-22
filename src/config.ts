/** Optional user config: ~/.pi/agent/pi-herd/config.json (or $PI_HERD_ROOT/config.json). */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type HerdConfig = {
	fleet?: { refreshMs?: number; showDone?: boolean; maxRows?: number; completedTtlMs?: number };
	spawnPlacement?: "tab" | "split";
	/** Grace window (ms) to let a child dump result.md before its pane is closed. 0 disables. Default 180000. */
	rescueMs?: number;
	/** Keep subagents running across `/reload` (session_start re-attaches to them). Default true. */
	keepChildrenOnReload?: boolean;
};

export function configPath(): string {
	const root = process.env.PI_HERDR_ROOT || process.env.PI_HERD_ROOT || join(homedir(), ".pi", "agent", "pi-herdr");
	return join(root, "config.json");
}

let cached: HerdConfig | undefined;

export function loadConfig(): HerdConfig {
	if (cached) return cached;
	try {
		cached = JSON.parse(readFileSync(configPath(), "utf8")) as HerdConfig;
	} catch {
		cached = {};
	}
	return cached;
}
