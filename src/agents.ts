/** Minimal agent-definition loader: `<dir>/*.md` with YAML-ish frontmatter. */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export type AgentDef = {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools: string[];
	body: string;
	file: string;
};

function strip(raw: string): string {
	return raw.trim().replace(/^["']|["']$/g, "");
}

function parseTools(raw: string | undefined): string[] {
	if (!raw) return [];
	const inner = raw.trim().replace(/^\[|\]$/g, "");
	return inner
		.split(",")
		.map((t) => strip(t))
		.filter(Boolean);
}

export function parseAgent(file: string, text: string): AgentDef | undefined {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return undefined;
	let end = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			end = i;
			break;
		}
	}
	if (end < 0) return undefined;
	const meta: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const at = line.indexOf(":");
		if (at <= 0) continue;
		meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	if (!meta.name) return undefined;
	return {
		name: strip(meta.name),
		description: strip(meta.description ?? ""),
		model: meta.model ? strip(meta.model) : undefined,
		thinking: meta.thinking ? strip(meta.thinking) : undefined,
		tools: parseTools(meta.tools),
		body: lines.slice(end + 1).join("\n").trim(),
		file,
	};
}

export async function loadAgents(dir: string): Promise<AgentDef[]> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	const defs: AgentDef[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const file = join(dir, entry);
		const def = parseAgent(file, await readFile(file, "utf8").catch(() => ""));
		if (def) defs.push(def);
	}
	defs.sort((a, b) => a.name.localeCompare(b.name));
	return defs;
}

/**
 * Merge agent definitions: the user directory wins per name, falling back to the
 * packaged defaults for any field the user file leaves out. Later directories only
 * fill gaps, so a user file may override just the model or just the prompt.
 */
export async function loadAgentSet(userDir: string, builtinDir: string): Promise<AgentDef[]> {
	const [user, builtin] = await Promise.all([loadAgents(userDir), loadAgents(builtinDir)]);
	const merged = new Map<string, AgentDef>();
	for (const def of builtin) merged.set(def.name, def);
	for (const def of user) {
		const base = merged.get(def.name);
		merged.set(
			def.name,
			base
				? {
						...def,
						description: def.description || base.description,
						model: def.model ?? base.model,
						thinking: def.thinking ?? base.thinking,
						tools: def.tools.length ? def.tools : base.tools,
						body: def.body || base.body,
					}
				: def,
		);
	}
	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}
