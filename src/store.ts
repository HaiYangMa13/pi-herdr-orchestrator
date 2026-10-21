/** Durable on-disk state. Disk is the only authority; memory is a cache. */

import { homedir } from "node:os";
import { join } from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";

export type MetaState =
	| "starting"
	| "running"
	| "done"
	| "blocked"
	| "no_result"
	| "timeout"
	| "failed"
	| "closed";

export const TERMINAL_STATES: MetaState[] = ["done", "closed", "failed", "no_result", "timeout"];

export type Meta = {
	label: string;
	herdrName: string;
	definition: string;
	paneId: string;
	tabId?: string;
	piSessionId: string;
	cwd: string;
	startedAt: number;
	state: MetaState;
	keepAlive?: boolean;
	taskGate?: unknown;
	endedAt?: number;
	closedAt?: number;
	exitReason?: string;
};

export function rootDir(): string {
	return process.env.PI_HERDR_ROOT || process.env.PI_HERD_ROOT || join(homedir(), ".pi", "agent", "pi-herdr");
}

export function runDir(sessionId: string): string {
	return join(rootDir(), "runs", sessionId);
}

export function agentPaths(sessionId: string, label: string) {
	const dir = join(runDir(sessionId), label);
	return {
		dir,
		meta: join(dir, "meta.json"),
		task: join(dir, "task.md"),
		result: join(dir, "result.md"),
		ask: join(dir, "ask.json"),
		log: join(dir, "log.jsonl"),
	};
}

export async function ensureDir(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
}

export async function readJson(path: string): Promise<any> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
}

export async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

// One write queue per label so read-modify-write cannot interleave.
const queues = new Map<string, Promise<unknown>>();

function queued<T>(key: string, task: () => Promise<T>): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const next = previous.then(task, task);
	queues.set(
		key,
		next.catch(() => undefined),
	);
	return next;
}

/** Atomic write: temp file in the same directory, then rename. */
export async function writeMeta(sessionId: string, label: string, meta: Meta): Promise<void> {
	const paths = agentPaths(sessionId, label);
	await queued(`meta:${paths.meta}`, async () => {
		await ensureDir(paths.dir);
		const tmp = `${paths.meta}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(meta, null, 2));
		await rename(tmp, paths.meta);
	});
}

/** Serialized read-modify-write of meta.json. */
export async function updateMeta(
	sessionId: string,
	label: string,
	patch: (current: Meta) => Meta,
): Promise<Meta | undefined> {
	const paths = agentPaths(sessionId, label);
	return queued(`meta:${paths.meta}`, async () => {
		const current = (await readJson(paths.meta)) as Meta | undefined;
		if (!current) return undefined;
		const next = patch(current);
		await ensureDir(paths.dir);
		const tmp = `${paths.meta}.${process.pid}.tmp`;
		await writeFile(tmp, JSON.stringify(next, null, 2));
		await rename(tmp, paths.meta);
		return next;
	});
}

export async function writeTask(sessionId: string, label: string, task: string, files: string[]): Promise<void> {
	const paths = agentPaths(sessionId, label);
	await ensureDir(paths.dir);
	const body = files.length ? `${task}\n\n## 先读这些文件\n${files.map((f) => `- ${f}`).join("\n")}\n` : task;
	await writeFile(paths.task, body);
}

export async function logLine(sessionId: string, label: string, event: string, data?: unknown): Promise<void> {
	const paths = agentPaths(sessionId, label);
	try {
		await ensureDir(paths.dir);
		await appendFile(paths.log, `${JSON.stringify({ at: new Date().toISOString(), event, data })}\n`);
	} catch {
		/* logging must never break orchestration */
	}
}

export async function listLabels(sessionId: string): Promise<string[]> {
	try {
		const entries = await readdir(runDir(sessionId), { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

export async function removeFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		/* already gone */
	}
}
