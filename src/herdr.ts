/** Thin, argv-safe wrapper over the herdr CLI. No shell strings, no readiness probing. */

export type ExecFn = (
	cmd: string,
	args: string[],
	opts?: { signal?: AbortSignal; timeout?: number; cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;

export type HerdrAgent = {
	name?: string;
	pane_id?: string;
	agent_status?: string;
	completion_seq?: number;
	[key: string]: unknown;
};

export type Terminal = { status: string; timedOut: boolean };

function pickJson(text: string): any {
	const raw = text.trim();
	if (!raw) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		/* fall through: CLI may print a banner before the payload */
	}
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	try {
		return JSON.parse(raw.slice(start, end + 1));
	} catch {
		return undefined;
	}
}

/**
 * Split axis for a pane of this size: keep splitting right while the pane is
 * clearly wider than tall, otherwise split down. This grows a shared tab into a
 * balanced grid (1 wide -> 2 wide -> 2x2 -> 2x3) instead of a row of slivers.
 */
export function chooseSplitDirection(width: number, height: number): "right" | "down" {
	if (!(width > 0) || !(height > 0)) return "right";
	return width > height * 1.6 ? "right" : "down";
}

export function createHerdr(exec: ExecFn) {
	let allocationQueue: Promise<unknown> = Promise.resolve();
	async function call(args: string[], timeoutMs = 30_000, signal?: AbortSignal) {
		const res = await exec("herdr", args, { signal, timeout: timeoutMs + 5_000 });
		const raw = `${res.stdout ?? ""}${res.stderr ?? ""}`;
		const json = pickJson(raw);
		if (json?.error) {
			const error: any = new Error(
				`herdr ${args.slice(0, 2).join(" ")}: ${json.error.code ?? "error"} ${json.error.message ?? ""}`.trim(),
			);
			error.herdrCode = json.error.code;
			error.raw = raw;
			throw error;
		}
		// pi.exec reports a SIGTERM'd child as code 0, so trust `killed` first.
		if (res.killed) {
			const error: any = new Error(`herdr ${args.slice(0, 2).join(" ")} timed out after ${timeoutMs}ms`);
			error.herdrCode = "timeout";
			throw error;
		}
		if ((res.code ?? 0) !== 0) {
			const error: any = new Error(
				`herdr ${args.slice(0, 2).join(" ")} exited ${res.code}: ${raw.trim().slice(-300) || "no output"}`,
			);
			error.herdrCode = "exit";
			throw error;
		}
		if (json === undefined && /traceback|error|not found/i.test(raw)) {
			const error: any = new Error(`herdr ${args.slice(0, 2).join(" ")}: ${raw.trim().slice(-300)}`);
			error.herdrCode = "unparsed";
			throw error;
		}
		return { json, raw };
	}

	async function list(): Promise<HerdrAgent[]> {
		const { json } = await call(["agent", "list"]);
		const agents = json?.result?.agents;
		return Array.isArray(agents) ? agents : [];
	}

	async function find(name: string): Promise<HerdrAgent | undefined> {
		try {
			return (await list()).find((a) => a.name === name);
		} catch {
			// A failed listing must never be read as "agent gone".
			throw new Error(`herdr agent list failed while looking for ${name}`);
		}
	}

	/**
	 * Choose which pane to split and along which axis so a shared tab grows into a
	 * balanced grid instead of a row of slivers: always split the largest pane,
	 * and split right only while it is clearly wider than tall.
	 */
	async function gridSplitTarget(anchorPaneId: string): Promise<{ paneId: string; direction: "right" | "down" }> {
		const fallback = { paneId: anchorPaneId, direction: "right" as const };
		let panes: any[] = [];
		try {
			const { json } = await call(["pane", "layout", "--pane", anchorPaneId]);
			panes = json?.result?.layout?.panes ?? [];
		} catch {
			return fallback;
		}
		const sized = panes
			.filter((p) => p?.pane_id && Number(p?.rect?.width) > 0 && Number(p?.rect?.height) > 0)
			.map((p) => ({ paneId: String(p.pane_id), width: Number(p.rect.width), height: Number(p.rect.height) }));
		if (sized.length === 0) return fallback;
		const largest = sized.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
		return { paneId: largest.paneId, direction: chooseSplitDirection(largest.width, largest.height) };
	}

	async function sessionPane(sessionId: string): Promise<any> {
		const { json } = await call(["pane", "list"]);
		if (!Array.isArray(json?.result?.panes)) throw new Error("Invalid pane list response");
		const matches = json.result.panes.filter((p: any) => {
			const file = p.agent_session?.value;
			return typeof file === "string" && (file === sessionId || file.endsWith(`_${sessionId}.jsonl`));
		});
		if (matches.length > 1) throw new Error("Ambiguous session pane; refusing to focus");
		return matches[0];
	}

	return {
		list,
		find,
		sessionPane,
		async focusSession(targetSessionId: string, parentSessionId: string): Promise<boolean> {
			const parent = await sessionPane(parentSessionId);
			const target = await sessionPane(targetSessionId);
			if (!parent || !target) return false;
			if (target.workspace_id !== parent.workspace_id) throw new Error("Target is outside parent workspace; refusing to focus");
			await call(["agent", "focus", target.pane_id]);
			return true;
		},
		async renamePane(paneId: string, title: string): Promise<void> {
			await call(["pane", "rename", paneId, title]);
		},
		async renameTab(tabId: string, title: string): Promise<void> {
			await call(["tab", "rename", tabId, title]);
		},

		/** Existence probe that never throws: true only when herdr positively lists the agent. */
		async exists(name: string): Promise<boolean> {
			try {
				return Boolean(await find(name));
			} catch {
				return true; // unknown → treat as still there, so callers fall back to pane close
			}
		},

		async createTab(cwd: string, label: string, signal?: AbortSignal, workspaceId?: string): Promise<{ paneId: string; tabId?: string }> {
			if (!workspaceId) throw new Error("Refusing to create agent tab without parent workspace");
			const { json } = await call(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"], 30_000, signal);
			const paneId = json?.result?.root_pane?.pane_id;
			if (!paneId) throw new Error(`herdr tab create returned no pane id: ${JSON.stringify(json).slice(0, 200)}`);
			return { paneId: String(paneId), tabId: json?.result?.tab?.tab_id ? String(json.result.tab.tab_id) : undefined };
		},

		allocateSessionPane(cwd: string, sessionId: string): Promise<{ paneId: string; tabId: string }> {			const allocate = async () => {
				const label = `AGENTS · ${sessionId}`;
				const parentReply = await call(["pane", "list"]);
				const parentPanes = parentReply.json?.result?.panes;
				if (!Array.isArray(parentPanes)) throw new Error("Invalid parent pane list response");
				const parents = parentPanes.filter((p: any) => {
					const file = p.agent_session?.value;
					return typeof file === "string" && file.endsWith(`_${sessionId}.jsonl`);
				});
				if (parents.length !== 1 || !parents[0].workspace_id) {
					throw new Error("Cannot uniquely resolve parent workspace; refusing focused-workspace fallback");
				}
				const workspaceId = String(parents[0].workspace_id);
				const response = await call(["tab", "list"]);
				const tabs = response.json?.result?.tabs;
				if (!Array.isArray(tabs)) throw new Error("Invalid tab list response");
				const tab = tabs.find((t: any) => (t.label === label || t.label === `herd-${sessionId}`) && t.workspace_id === workspaceId);
				if (tab) {
					if (tab.label !== label) await this.renameTab(tab.tab_id, label);
					const reply = await call(["pane", "list"]);
					const panes = reply.json?.result?.panes;
					if (!Array.isArray(panes)) throw new Error("Invalid pane list response");
					const anchor = panes.find((p: any) => p.tab_id === tab.tab_id);
					if (!anchor) throw new Error("Shared tab has no pane; retry allocation");
					const target = await gridSplitTarget(anchor.pane_id);
					const split = await call([
						"pane",
						"split",
						"--pane",
						target.paneId,
						"--cwd",
						cwd,
						"--direction",
						target.direction,
						"--no-focus",
					]);
					const paneId = split.json?.result?.pane?.pane_id;
					if (!paneId) throw new Error("Shared-tab split returned no pane id");
					return { paneId: String(paneId), tabId: String(tab.tab_id) };
				}
				const created = await this.createTab(cwd, label, undefined, workspaceId);
				if (!created.tabId) throw new Error("New shared tab returned no tab id");
				return { paneId: created.paneId, tabId: created.tabId };
			};
			const pending = allocationQueue.then(allocate, allocate);
			allocationQueue = pending.catch(() => undefined);
			return pending;
		},

		async splitPane(cwd: string, signal?: AbortSignal): Promise<string> {			const { json } = await call(["pane", "split", "--cwd", cwd, "--direction", "right"], 30_000, signal);
			const id = json?.result?.pane?.pane_id;
			if (!id) throw new Error(`herdr pane split returned no pane id: ${JSON.stringify(json).slice(0, 200)}`);
			return String(id);
		},

		async start(name: string, paneId: string, piArgs: string[]): Promise<void> {
			await call(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--timeout", "60000", "--", ...piArgs], 90_000);
		},

		async prompt(name: string, text: string, timeoutMs = 90_000): Promise<void> {
			await call(["agent", "prompt", name, text, "--wait", "--until", "working", "--timeout", String(timeoutMs)], timeoutMs);
		},

		/** Queue text without waiting for a status change (steer / rescue prompts). */
		async nudge(name: string, text: string, timeoutMs = 45_000): Promise<void> {
			await call(["agent", "prompt", name, text], timeoutMs);
		},

		async waitTerminal(name: string, timeoutMs: number, signal?: AbortSignal): Promise<Terminal> {
			try {
				const { json } = await call(
					[
						"agent",
						"wait",
						name,
						"--until",
						"idle",
						"--until",
						"done",
						"--until",
						"blocked",
						"--until",
						"unknown",
						"--timeout",
						String(timeoutMs),
					],
					timeoutMs,
					signal,
				);
				return { status: String(json?.result?.agent?.agent_status ?? "unknown"), timedOut: false };
			} catch (error: any) {
				if (error?.herdrCode === "timeout" || /timed out/i.test(String(error?.message ?? ""))) {
					return { status: "timeout", timedOut: true };
				}
				if (/agent_not_found|not found/i.test(String(error?.message ?? ""))) {
					return { status: "gone", timedOut: false };
				}
				throw error;
			}
		},

		async read(name: string, lines = 80): Promise<string> {
			try {
				const res = await exec("herdr", ["agent", "read", name, "--source", "recent"], { timeout: 20_000 });
				return `${res.stdout ?? ""}`.split("\n").slice(-lines).join("\n");
			} catch {
				return "";
			}
		},

		async closeTab(tabId: string): Promise<void> {
			try {
				await call(["tab", "close", tabId], 20_000);
			} catch {
				/* already gone */
			}
		},

		async closePane(paneId: string): Promise<void> {
			try {
				await call(["pane", "close", paneId], 20_000);
			} catch {
				/* already gone */
			}
		},

		/** ctrl+c ctrl+d, then close pane/tab unconditionally so nothing is left behind. */
		async kill(name: string, paneId?: string, tabId?: string): Promise<{ closed: boolean; via: string }> {
			try {
				await call(["agent", "send-keys", name, "ctrl+c", "ctrl+d"], 20_000);
			} catch {
				/* agent may already be gone */
			}
			for (let i = 0; i < 12; i++) {
				if (!(await this.exists(name))) {
					if (paneId) await this.closePane(paneId);
					// Never close the shared tab: siblings may still be running.
					return { closed: true, via: "agent-exited" };
				}
				await new Promise((r) => setTimeout(r, 400));
			}
			const still = await find(name).catch(() => undefined);
			const targetPane = paneId ?? (still?.pane_id ? String(still.pane_id) : undefined);
			if (targetPane) await this.closePane(targetPane);
			// Closing the last pane lets herdr remove the empty tab.
			const after = await this.exists(name);
			return { closed: !after, via: after ? "close-failed" : "pane-closed" };
		},
	};
}

export type Herdr = ReturnType<typeof createHerdr>;
