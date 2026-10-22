/**
 * pi-herdr — herdr-based subagent orchestrator (pi extension).
 *
 * Design: DESIGN.md (repo root)
 * Verified herdr protocol (re-test before changing):
 *   tab create (or pane split) -> agent start --kind pi -> agent prompt --wait --until working
 *   -> agent wait --until idle|done|blocked|unknown -> read result.md from disk
 *   -> agent send-keys ctrl+c ctrl+d -> pane/tab close
 * Never probe readiness with `herdr pane run`; results come from files, not pane text.
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHerdr } from "./src/herdr.ts";
import { loadAgents, type AgentDef } from "./src/agents.ts";
import {
	agentPaths,
	ensureDir,
	listLabels,
	logLine,
	readJson,
	readText,
	removeFile,
	TERMINAL_STATES,
	updateMeta,
	writeMeta,
	writeTask,
	type Meta,
	type MetaState,
} from "./src/store.ts";
import { loadConfig } from "./src/config.ts";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { FleetView, type Row } from "./src/fleet-view.ts";
import { openNavigator } from "./src/navigation.ts";
import { showFleetRow, fleetRank } from "./src/fleet-policy.ts";
import { GUIDANCE_SECTION, herdGuidance } from "./src/guidance.ts";

const AGENT_DIR = fileURLToPath(new URL("./agents/", import.meta.url));

/** herdr installs its Pi integration into the Pi agent directory. */
function integrationCandidates(): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return [
		...(process.env.PI_HERDR_INTEGRATION ? [process.env.PI_HERDR_INTEGRATION] : []),
		join(agentDir, "extensions", "herdr-agent-state.ts"),
	];
}

function resolveIntegration(): string | undefined {
	return integrationCandidates().find((path) => existsSync(path));
}
const USER_AGENT_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "agents");

function rand8(): string {
	return Math.random().toString(16).slice(2, 10);
}

function sanitizeLabel(raw: string): string {
	const cleaned = raw
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.slice(0, 28) || `agent-${rand8()}`;
}

function lintResult(text: string): { ok: boolean; reasons: string[] } {
	const t = text.trim();
	const reasons: string[] = [];
	if (/^(READY\.?|done\.?|ok\.?|完成。?)$/i.test(t)) reasons.push("只有单字确认，没有实质内容");
	if (t.length < 120) reasons.push(`结果过短（${t.length} 字符 < 120）`);
	const sections = ["完成内容", "改动", "验证", "阻塞", "剩余"];
	const hit = sections.filter((section) => t.includes(section)).length;
	if (hit < 3) reasons.push(`缺少结构化章节（命中 ${hit}/5）`);
	return { ok: reasons.length === 0, reasons };
}

/**
 * Deterministic task-spec lint. Replaces the removed Jev task gate: no network, no model, no
 * degradation path. A spec that names neither a file nor an acceptance bar is rejected outright.
 */
function lintTask(task: string): { ok: boolean; missing: string[] } {
	const text = String(task ?? "").trim();
	const missing: string[] = [];
	const hasPath =
		/(?:^|[\s`'"(（,，])(?:~\/|\.{1,2}\/|\/)[^\s`'"()]+/m.test(text) ||
		/[\w.-]+\/[\w./-]*\.[a-z0-9]{1,6}\b/i.test(text);
	const hasAcceptance = /(验收|通过标准|acceptance|expected|assert|单测|测试|test)/i.test(text);
	if (text.length < 60) missing.push(`任务正文过短（${text.length} 字符 < 60），写清目标、边界与产出`);
	if (!hasPath) missing.push("没有具体文件路径（绝对路径或 repo 相对路径）");
	if (!hasAcceptance) missing.push("没有验收标准（验收 / acceptance / expected / 测试）");
	return { ok: missing.length === 0, missing };
}

function firstSentence(text: string): string {
	const at = text.search(/[.。](\s|$)/);
	return (at > 0 ? text.slice(0, at) : text).trim();
}

/** What the model must see before it can pick a definition: name, pinned model, and when to use it. */
function rosterText(list: AgentDef[]): string {
	return list
		.map((d) => {
			// A user file may leave `description` out; fall back to its first prompt line so the roster
			// never shows a dangling dash where the routing hint should be.
			const when = firstSentence(d.description || d.body.split("\n").find((line) => line.trim()) || d.name);
			return `- ${d.name} (${d.model ?? "inherit"}) — ${when}`;
		})
		.join("\n");
}

function describeOutcome(
	label: string,
	state: string,
	result: string | undefined,
	ask: any,
	paneTail: string | undefined,
	gate: any,
): string {
	const parts: string[] = [`## herd agent \`${label}\` — ${state}`];
	if (gate?.gated) {
		const conf = typeof gate.confidence === "number" ? ` (confidence ${gate.confidence.toFixed(2)})` : "";
		parts.push(`result gate: **${gate.verdict ?? "n/a"}**${conf}`);
		if (gate.missing?.length) parts.push(`gate findings: ${gate.missing.map((m: string) => `- ${m}`).join("; ")}`);
	} else {
		parts.push(`result gate: skipped (${gate?.reason ?? "no gate"})`);
	}
	if (ask) parts.push(`### 子 agent 提问（未回答，用 herd_reply）\n${JSON.stringify(ask, null, 2)}`);
	parts.push(result?.trim() ? `### 结果\n${result.trim()}` : "### 结果\n(缺失 result.md)");
	if (!result && paneTail) parts.push(`### 终端尾部（诊断）\n\`\`\`\n${paneTail.slice(-1500)}\n\`\`\``);
	return parts.join("\n\n");
}

const MARKS: Record<string,string> = { starting:"⠋", running:"⠏", blocked:"?", done:"+", no_result:"!", timeout:"!", failed:"x", spawn_failed:"x", closed:"." };

/** How many refreshes a child may be missing from `herdr agent list` before the strip calls it gone. */
const MISSES_BEFORE_GONE = 3;

// ------------------------------------------------------------------- extension

export default function (pi: ExtensionAPI) {
	let herd: ReturnType<typeof createHerdr> | undefined;
	let agents: AgentDef[] = [];
	let sessionId = "no-session";
	let shuttingDown = false;
	let fleetView: FleetView | undefined;
	let fleetTimer: ReturnType<typeof setInterval> | undefined;
	let rendering = false;
	const watchers = new Map<string, AbortController>();
	/** Consecutive refreshes whose listing lacked a child that should still be alive. */
	const agentMisses = new Map<string, number>();

	function bind(ctx: any) {
		if (!herd) {
			const exec = (cmd: string, args: string[], opts?: any) => pi.exec(cmd, args, opts);
			herd = createHerdr(exec as any);
		}
		return { h: herd! };
	}

	async function defs(): Promise<AgentDef[]> {
		// Re-read on every call so a new or edited role file applies without a reload.
		await seedDefinitions();
		// One directory, one source of truth: roles are never merged with the packaged files, so
		// deleting a role here really deletes it instead of resurrecting a builtin of the same name.
		agents = await loadAgents(USER_AGENT_DIR);
		return agents;
	}

	/** First run only: copy the packaged defaults into the owner's directory, then never read them again. */
	async function seedDefinitions(): Promise<void> {
		if ((await definitionNames(USER_AGENT_DIR)).length) return;
		const { mkdir, readFile: read, writeFile: write } = await import("node:fs/promises");
		const seeds = await definitionNames(AGENT_DIR);
		if (!seeds.length) return;
		await mkdir(USER_AGENT_DIR, { recursive: true }).catch(() => undefined);
		for (const name of seeds) {
			const text = await read(join(AGENT_DIR, name), "utf8").catch(() => "");
			if (text) await write(join(USER_AGENT_DIR, name), text).catch(() => undefined);
		}
	}

	async function definitionNames(dir: string): Promise<string[]> {
		const { readdir } = await import("node:fs/promises");
		return (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md")).sort();
	}

	const definitionSnapshot = () => definitionNames(USER_AGENT_DIR);

	/**
	 * Agent definitions are owner-only. The child-side guard blocks the write; this is the audit that
	 * catches what a shell one-liner slipped past it. New files are moved into the run dir, never
	 * deleted, and pre-existing definitions are left untouched (a child cannot cost the owner a role).
	 */
	async function auditDefinitions(sessionId: string, label: string, before: string[]): Promise<string[]> {
		const added = (await definitionNames(USER_AGENT_DIR)).filter((name) => !before.includes(name));
		if (!added.length) return [];
		const { rename: move } = await import("node:fs/promises");
		const quarantine = join(agentPaths(sessionId, label).dir, "tampered");
		await ensureDir(quarantine);
		const moved: string[] = [];
		for (const name of added) {
			await move(join(USER_AGENT_DIR, name), join(quarantine, name)).catch(() => undefined);
			moved.push(name);
		}
		await logLine(sessionId, label, "definition-tamper", { added: moved, quarantine });
		return moved;
	}

	function piArgsFor(def: AgentDef, label: string, piSessionId: string): string[] {
		const args: string[] = [];
		if (def.model) args.push("--model", def.model);
		if (def.thinking) args.push("--thinking", def.thinking);
		if (def.tools.length) args.push("--tools", def.tools.join(","));
		const integration = resolveIntegration();
		if (!integration) {
			throw new Error(
				`herdr's Pi integration is missing (looked for ${integrationCandidates().join(", ")}). ` +
					"Run `herdr integration install pi`, or set PI_HERDR_INTEGRATION to its path.",
			);
		}
		args.push("--no-extensions", "--no-skills", "--extension", integration, "--extension", fileURLToPath(new URL("./child-ui.ts", import.meta.url)), "--herdr-parent", sessionId, "--herdr-label", label, "--herdr-role", def.name, "--approve", "--name", `SUB · ${label}`, "--session-id", piSessionId);
		return args;
	}

	function contractHeader(paths: ReturnType<typeof agentPaths>, def: AgentDef, notes: string[] = []): string {
		const lines = [
			`你是 ${def.name}，只执行本次分配，不得委派或提议再开子 agent。`,
			`禁止新建或修改 agent 定义（~/.pi/agent/agents/*.md）与 pi-herdr 配置；需要新角色就写进结果文件交给 owner。`,
			`任务正文见 ${paths.task}（先读它）。`,
			`最终结果必须写入文件 ${paths.result}，Markdown，含五节：完成内容 / 改动文件 / 验证程度（编译·单测·真机·未验证） / 阻塞与风险 / 剩余工作。没验证就写「未验证」。`,
			`需要 owner 决策时：把 {"question":"...","options":[...]} 写入 ${paths.ask} 后停止，不要猜。`,
			`禁止只回 READY./done 之类单字结束；禁止在没有文本总结时结束回合。`,
		];
		if (notes.length) lines.push(`任务书自检提醒（不阻断）：${notes.join("；")}`);
		return lines.join("\n");
	}

	function mountWidget(ctx: any) {
		if (!ctx?.hasUI || fleetView) return;
		try {
			ctx.ui.setWidget(
				"pi-herd-fleet",
				(tui: any, theme: any) => {
					fleetView = new FleetView();
					fleetView.tui = tui;
					fleetView.theme = theme;
					return fleetView;
				},
				{ placement: "aboveEditor" },
			);
		} catch {
			/* UI is best effort */
		}
	}

	function unmountWidget(ctx: any) {
		if (!fleetView) return;
		fleetView = undefined;
		try {
			ctx?.ui?.setWidget?.("pi-herd-fleet", undefined);
			ctx?.ui?.setStatus?.("pi-herd", undefined);
		} catch {
			/* ignore */
		}
	}

	async function refreshFleet(ctx: any) {
		if (!ctx?.hasUI || rendering) return;
		rendering = true;
		try {
			const labels = await listLabels(sessionId);
			const live = labels.length ? await bind(ctx).h.list().catch(() => undefined) : [];
			const rows: Row[] = [];
			const fleetConfig = loadConfig().fleet ?? {};
			const now = Date.now();
			let running = 0;
			let blocked = 0;
			let finished = 0;
			let attention = 0;
			for (const label of labels) {
				const meta = (await readJson(agentPaths(sessionId, label).meta)) as Meta | undefined;
				if (!meta) continue;
				const agent = live?.find((a) => a.name === meta.herdrName);
				const askPending = Boolean(await readJson(agentPaths(sessionId, label).ask));
				let state: string = meta.state;
				if (agent?.agent_status === "working") state = "running";
				else if (agent?.agent_status === "blocked") state = "blocked";
				if (agent || (state !== "running" && state !== "starting")) agentMisses.delete(label);
				else if (live !== undefined) {
					// One missing listing entry is not a death certificate. herdr can drop a name for a refresh
					// while the pane is alive, and pi retries a stream error instead of dying, so wait it out
					// before painting a failure the run does not have.
					const misses = (agentMisses.get(label) ?? 0) + 1;
					agentMisses.set(label, misses);
					if (misses >= MISSES_BEFORE_GONE) state = "failed";
				}
				if (askPending && state !== "closed" && state !== "done" && state !== "failed") state = "blocked";
				if (!showFleetRow(meta, state, live === undefined || Boolean(agent), now, fleetConfig)) continue;
				if (state === "running" || state === "starting") running++;
				else if (state === "blocked") blocked++;
				else if (state === "done") finished++;
				else if (["failed","timeout","no_result"].includes(state)) attention++;
				const ask = askPending ? await readJson(agentPaths(sessionId, label).ask) : undefined;
				const result = await readText(agentPaths(sessionId, label).result);
				const secs = Math.max(0, Math.round(((meta.endedAt ?? Date.now()) - meta.startedAt) / 1000));
				const dur = secs >= 60 ? `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s` : `${secs}s`;
				const flags = ask ? "ASK" : state === "done" && agent ? "live" : result ? "result" : "";
				rows.push({ mark: MARKS[state] ?? " ", state, label, def: meta.definition, dur, flags });
			}
			rows.sort((a, b) => fleetRank(a.state) - fleetRank(b.state) || a.label.localeCompare(b.label));
			if (!rows.length) {
				unmountWidget(ctx);
				return;
			}
			const maxRows = Math.max(1, Math.min(20, Math.floor(loadConfig().fleet?.maxRows ?? 5)));
			const shown = rows.slice(0, maxRows);
			if (rows.length > maxRows) {
				shown.push({
					mark: " ",
					state: "closed",
					label: `+${rows.length - maxRows} more`,
					def: "",
					dur: "",
					flags: "/herdr",
				});
			}
			mountWidget(ctx);
			if (!fleetView) return;
			fleetView.rows = shown;
			const blockedPart = blocked ? ` · ${blocked} blocked` : "";
			const attentionPart = attention ? ` · ${attention} error` : "";
			const finishedPart = finished ? ` · ${finished} done` : "";
			fleetView.summary = `${running} running${blockedPart}${attentionPart}${finishedPart}`;
			fleetView.tui?.requestRender?.();
			ctx.ui.setStatus?.("pi-herd", `herd ${running} running${blocked ? ` ${blocked} blocked` : ''}${attention ? ` ${attention} error` : ''}`);
		} catch {
			/* display must never break orchestration */
		} finally {
			rendering = false;
		}
	}

	function startFleetTimer(ctx: any) {
		stopFleetTimer();
		const refresh = loadConfig().fleet?.refreshMs ?? 2000;
		fleetTimer = setInterval(() => {
			void refreshFleet(ctx);
		}, Math.max(500, refresh));
		if (typeof (fleetTimer as any).unref === "function") (fleetTimer as any).unref();
		void refreshFleet(ctx);
	}

	function stopFleetTimer() {
		if (fleetTimer) clearInterval(fleetTimer);
		fleetTimer = undefined;
	}

	// -------------------------------------------------------------- watch/终端

	const rescuePrompt = (resultPath: string) =>
		[
			"时间到或回合已结束，但结果文件还没写。",
			"立刻停止一切作业：不要继续改代码、不要跑新测试、不要开新排查。",
			`现在只做一件事：把你目前已完成的内容写成五节报告写入 ${resultPath}（完成内容 / 改动文件 / 验证程度 / 阻塞与风险 / 剩余工作）。没验证就写「未验证」。`,
			"写完这个文件就结束回合。",
		].join("\n");

	/**
	 * A child that ended its own turn, or blew its wait budget, without writing result.md has not
	 * lost its work yet: its pane is still alive. Ask once for the report and give it a short grace
	 * window before anything is closed, otherwise the entire run is discarded.
	 */
	async function rescueBeforeClose(
		h: ReturnType<typeof createHerdr>,
		label: string,
		meta: Meta,
		resultPath: string,
	): Promise<string | undefined> {
		const graceMs = Math.max(0, loadConfig().rescueMs ?? 180_000);
		if (!graceMs) return undefined;
		const startedAt = Date.now();
		try {
			await h.nudge(meta.herdrName, rescuePrompt(resultPath));
			await logLine(sessionId, label, "rescue", { graceMs });
		} catch (error: any) {
			await logLine(sessionId, label, "rescue-failed", String(error?.message ?? error));
			return undefined;
		}
		while (Date.now() - startedAt < graceMs) {
			if (shuttingDown) return undefined;
			await new Promise((resolve) => setTimeout(resolve, 5_000));
			const text = await readText(resultPath);
			if (text?.trim()) {
				await logLine(sessionId, label, "rescued", { ms: Date.now() - startedAt });
				return text;
			}
		}
		await logLine(sessionId, label, "rescue-gave-up", { ms: Date.now() - startedAt });
		return undefined;
	}

	async function watch(label: string, ctx: any, timeoutMs: number, notify: boolean): Promise<any> {
		const paths = agentPaths(sessionId, label);
		const meta = (await readJson(paths.meta)) as Meta | undefined;
		if (!meta) throw new Error(`no such herd agent: ${label}`);

		if (TERMINAL_STATES.includes(meta.state) || meta.state === "blocked") {
			const result = await readText(paths.result);
			const ask = meta.state === "blocked" ? await readJson(paths.ask) : undefined;
			return {
				state: meta.state,
				result,
				ask,
				meta,
				gate: { gated: false, reason: "already recorded on disk" },
				text: describeOutcome(label, meta.state, result, ask, undefined, { gated: false, reason: "already recorded on disk" }),
			};
		}

		const { h } = bind(ctx);
		const controller = new AbortController();
		const previous = watchers.get(label);
		if (previous) previous.abort();
		watchers.set(label, controller);

		let terminal;
		try {
			terminal = await h.waitTerminal(meta.herdrName, timeoutMs, controller.signal);
		} finally {
			if (watchers.get(label) === controller) watchers.delete(label);
		}

		if (controller.signal.aborted || shuttingDown) throw new Error('watch cancelled');
		let result = await readText(paths.result);
		let ask = await readJson(paths.ask);
		let state: MetaState;
		if (ask) state = "blocked";
		else if (result?.trim()) state = "done";
		else if (terminal.timedOut) state = "timeout";
		else state = "no_result";

		// Two ways a child can end without a report: it stopped its own turn (model/stream error,
		// context saturation, or it simply stopped early) or its wait budget ran out. Both used to
		// close the pane at once and throw the whole run away; ask for the report first.
		let rescued = false;
		if (!ask && !result?.trim() && !meta.keepAlive) {
			const text = await rescueBeforeClose(h, label, meta, paths.result);
			if (text?.trim()) {
				result = text;
				state = "done";
				rescued = true;
			} else {
				ask = await readJson(paths.ask);
				if (ask) state = "blocked";
			}
		}

		const paneTail =
			state === "no_result" || state === "timeout" ? await h.read(meta.herdrName, 80).catch(() => "") : undefined;
		const lint = result?.trim() ? lintResult(result) : undefined;
		const gate = !result?.trim()
			? { gated: false, reason: "no result text" }
			: lint && !lint.ok
				? { gated: true, verdict: "suspect", missing: lint.reasons }
				: { gated: true, verdict: "pass", missing: [] as string[] };

		let closeInfo = "";
		const shouldClose = !meta.keepAlive && state !== "blocked";
		if (shouldClose) {
			// Close first, then record: a crash mid-close must not hide a live pane.
			const outcome = await h.kill(meta.herdrName, meta.paneId, meta.tabId).catch(() => ({ closed: false, via: "kill-error" }));
			closeInfo = `;auto-close:${outcome.via}`;
		}

		const updated = await updateMeta(sessionId, label, (current) => current.state === 'closed' ? current : ({
			...current,
			state,
			endedAt: Date.now(),
			closedAt: shouldClose ? Date.now() : current.closedAt,
			exitReason: `${terminal.status}${rescued ? ";rescued" : ""}${closeInfo}`,
		}));
		await logLine(sessionId, label, `terminal:${state}`, {
			herdrStatus: terminal.status,
			verdict: (gate as any)?.verdict,
			closed: shouldClose,
		});
		void refreshFleet(ctx);

		const tampered = await auditDefinitions(sessionId, label, meta.defsSnapshot ?? []);
		const outcomeText = describeOutcome(label, state, result, ask, paneTail, gate);
		const text = tampered.length
			? `## ⚠ 子 agent 新增了 agent 定义，已隔离到 ${join(agentPaths(sessionId, label).dir, "tampered")}\n${tampered.map((n) => `- ${n}`).join("\n")}\n\n${outcomeText}`
			: outcomeText;
		if (notify && !shuttingDown && updated?.state !== 'closed') {
			try {
				pi.sendMessage({ customType: "herd-agent-result", content: text, display: true }, { triggerTurn: true });
			} catch {
				/* parent may be gone */
			}
		}
		return { state, result, ask, meta: updated ?? meta, gate, text };
	}

	function watchInBackground(label: string, ctx: any, timeoutMs: number) {
		void watch(label, ctx, timeoutMs, true).catch((error: any) =>
			logLine(sessionId, label, "watch-error", String(error?.message ?? error)),
		);
	}

	// ------------------------------------------------------------------- tools

	pi.registerTool({
		name: "herd_spawn",
		label: "herd_spawn",
		description:
			"Spawn a herdr-hosted pi subagent in this parent session's shared agents tab for one bounded assignment. Returns immediately (async, default) and wakes this session with herd-agent-result at a terminal state. The child writes its result to a file.",
		parameters: Type.Object({
			task: Type.String({ description: "Full task text. Must contain acceptance criteria and concrete file paths." }),
			definition: Type.Optional(Type.String({ description: "Agent definition name; pass one from the roster herd_status prints (name (model) — when to use it). Required: an unknown name is rejected, never substituted." })),
			label: Type.Optional(Type.String({ description: "Short label, e.g. build-api." })),
			files: Type.Optional(Type.Array(Type.String(), { description: "File paths the child must read first." })),
			async: Type.Optional(Type.Boolean({ description: "Return immediately and wake later. Default true." })),
			cwd: Type.Optional(Type.String({ description: "Child working directory. Defaults to session cwd." })),
			timeoutMs: Type.Optional(Type.Number({ description: "Terminal wait budget in ms. Default 1800000." })),
			keepAlive: Type.Optional(
				Type.Boolean({
					description:
						"Leave the agent running after its terminal state so you can steer/reply. Default false: panes are closed automatically to avoid orphans.",
				}),
			),
		}),
		async execute(_toolCallId, params: any, signal, _onUpdate, ctx) {
			const { h } = bind(ctx);
			const available = await defs();
			const roster = rosterText(available);
			const definition = params.definition as string | undefined;
			// No router: the model picks a role from the roster shown to it, and an unknown or missing
			// name is a hard error. Silently substituting a default role is how agents end up running
			// under the wrong permissions and model.
			if (!definition) throw new Error(`definition is required; pass one of:\n${roster}`);
			const def = available.find((d) => d.name === definition);
			if (!def) throw new Error(`unknown definition '${definition}'; available:\n${roster}`);

			const spec = lintTask(params.task);
			const noPath = spec.missing.some((m) => m.startsWith("没有具体文件路径"));
			const noBar = spec.missing.some((m) => m.startsWith("没有验收标准"));
			if (noPath && noBar) throw new Error(`task spec rejected: ${spec.missing.join("；")}。补上验收标准和具体路径后重试。`);

			const base = sanitizeLabel(params.label ?? `${def.name}-${rand8()}`);
			const existing = (await readJson(agentPaths(sessionId, base).meta)) as Meta | undefined;
			const label =
				existing && !TERMINAL_STATES.includes(existing.state) ? `${base}-${rand8()}` : base;
			const paths = agentPaths(sessionId, label);
					const herdrName = `${label.slice(0, 23)}_${rand8()}`;
			const cwd = params.cwd ?? ctx.cwd;
			await ensureDir(paths.dir);
			await writeTask(sessionId, label, params.task, params.files ?? []);

			const placement = loadConfig().spawnPlacement ?? "tab";
			let paneId: string;
			let tabId: string | undefined;
			if (placement === "tab") {
				const created = await h.allocateSessionPane(cwd, sessionId);
				paneId = created.paneId;
				tabId = created.tabId;
			} else {
				paneId = await h.splitPane(cwd, signal);
			}

			const meta: Meta = {
				label,
				herdrName,
				definition: def.name,
				paneId,
				tabId,
				piSessionId: randomUUID(),
				cwd,
				startedAt: Date.now(),
				state: "starting",
				keepAlive: params.keepAlive === true,
				taskGate: { ok: spec.ok, missing: spec.missing },
				defsSnapshot: await definitionSnapshot(),
			};
			await writeMeta(sessionId, label, meta);
			await logLine(sessionId, label, "pane", { paneId, tabId, placement, taskGate: meta.taskGate });

			try {
				await h.start(herdrName, paneId, piArgsFor(def, label, meta.piSessionId));
				await h.renamePane(paneId, `SUB · ${label}`).catch(() => undefined);
				await writeMeta(sessionId, label, { ...meta, state: "running" });
			} catch (error: any) {
				const reason = String(error?.message ?? error);
				await writeMeta(sessionId, label, { ...meta, state: "spawn_failed", endedAt: Date.now(), exitReason: reason });
				await logLine(sessionId, label, "spawn-failed", reason);
				await h.kill(herdrName, paneId, tabId).catch(() => undefined);
				throw new Error(`agent start failed: ${reason}`);
			}
			// Handing over the task is not the same as starting the agent. A prompt timeout means delivery
			// is unconfirmed, not that the run failed: the child is alive, its pane is the place to retry,
			// and the watcher nudges again on rescue. Killing a healthy child here threw away whole runs.
			for (let attempt = 1; attempt <= 2; attempt++) {
				try {
					await h.prompt(herdrName, contractHeader(paths, def, spec.missing), 90_000);
					await logLine(sessionId, label, "prompted", { attempt });
					break;
				} catch (error: any) {
					const reason = String(error?.message ?? error);
					await logLine(sessionId, label, attempt === 1 ? "prompt-retry" : "prompt-unconfirmed", reason);
					if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, 2_000));
				}
			}

			void refreshFleet(ctx);
			const timeoutMs = params.timeoutMs ?? 1_800_000;
			const notify = params.async !== false;
			if (!notify) {
				const outcome = await watch(label, ctx, timeoutMs, false);
				return {
					content: [{ type: "text" as const, text: outcome.text }],
					details: { label, state: outcome.state, gate: outcome.gate },
				};
			}
			watchInBackground(label, ctx, timeoutMs);
			return {
				content: [
					{
						type: "text" as const,
						text: [
							`herd agent started`,
							`label: ${label}`,
							`herdr: ${herdrName}`,
							`pane: ${paneId}${tabId ? ` (tab ${tabId})` : ""}`,
							`definition: ${def.name}`,
							`taskGate: ${JSON.stringify(meta.taskGate)}`,
							`result: ${paths.result}`,
							`ask: ${paths.ask}`,
							``,
							`You will be woken with herd-agent-result at a terminal state. Meanwhile: herd_status / herd_steer / herd_reply / herd_close.`,
						].join("\n"),
					},
				],
				details: { label, herdrName, paneId, tabId, definition: def.name, state: "running" },
			};
		},
	});

	pi.registerTool({
		name: "herd_wait",
		label: "herd_wait",
		description: "Block until a herd agent reaches a terminal state; return its result file, ask file and the local result lint.",
		parameters: Type.Object({ label: Type.String(), timeoutMs: Type.Optional(Type.Number({ description: "Default 1800000" })) }),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const outcome = await watch(params.label, ctx, params.timeoutMs ?? 1_800_000, false);
			return {
				content: [{ type: "text" as const, text: outcome.text }],
				details: { label: params.label, state: outcome.state, gate: outcome.gate },
			};
		},
	});

	pi.registerTool({
		name: "herd_status",
		label: "herd_status",
		description: "List this session's herd agents and the definition roster available to herd_spawn.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const { h } = bind(ctx);
			const labels = await listLabels(sessionId);
			const live = labels.length ? await h.list().catch(() => []) : [];
			const rows: string[] = [];
			for (const label of labels) {
				const meta = (await readJson(agentPaths(sessionId, label).meta)) as Meta | undefined;
				if (!meta) continue;
				const agent = live.find((a) => a.name === meta.herdrName);
				const result = await readText(agentPaths(sessionId, label).result);
				const ask = await readJson(agentPaths(sessionId, label).ask);
				const mins = Math.round(((meta.endedAt ?? Date.now()) - meta.startedAt) / 60000);
				rows.push(
					`${label} | def=${meta.definition} | disk=${meta.state} | herdr=${agent?.agent_status ?? "gone"} | result=${result ? "yes" : "no"} | ask=${ask ? "YES" : "no"} | ${mins}m | pane=${meta.paneId ?? "-"}${meta.tabId ? ` | tab=${meta.tabId}` : ""}`,
				);
			}
			const text = rows.length ? `herd agents (session ${sessionId}):\n${rows.join("\n")}` : `no herd agents in session ${sessionId}`;
			const roster = rosterText(await defs());
			const full = `${text}\n\ndefinitions (pass one as herd_spawn definition):\n${roster}`;
			return { content: [{ type: "text" as const, text: full }], details: { count: rows.length } };
		},
	});

	pi.registerTool({
		name: "herd_steer",
		label: "herd_steer",
		description: "Send additional direction to a running herd agent.",
		parameters: Type.Object({ label: Type.String(), message: Type.String() }),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const { h } = bind(ctx);
			const meta = (await readJson(agentPaths(sessionId, params.label).meta)) as Meta | undefined;
			if (!meta) throw new Error(`no such herd agent: ${params.label}`);
			await h.prompt(meta.herdrName, params.message, 60_000);
			await logLine(sessionId, params.label, "steer", { chars: params.message.length });
			return { content: [{ type: "text" as const, text: `steered ${params.label}` }], details: { label: params.label } };
		},
	});

	pi.registerTool({
		name: "herd_reply",
		label: "herd_reply",
		description: "Answer a herd agent that asked a question (wrote ask.json), then clear the ask marker.",
		parameters: Type.Object({
			label: Type.String(),
			answer: Type.String(),
			timeoutMs: Type.Optional(Type.Number({ description: "Default 1800000" })),
		}),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const { h } = bind(ctx);
			const paths = agentPaths(sessionId, params.label);
			const meta = (await readJson(paths.meta)) as Meta | undefined;
			if (!meta) throw new Error(`no such herd agent: ${params.label}`);
			const ask = await readJson(paths.ask);
			if (ask) {
				await ensureDir(paths.dir);
				const { writeFile } = await import("node:fs/promises");
				await writeFile(`${paths.ask}.answered`, JSON.stringify(ask, null, 2));
			}
			// Deliver first: a failed prompt must not destroy the pending question.
			await h.prompt(meta.herdrName, `owner 回答：${params.answer}\n继续完成任务，最终结果写入 ${paths.result}。`, 60_000);
			await removeFile(paths.ask);
			await updateMeta(sessionId, params.label, (current) => ({
				...current,
				state: "running",
				endedAt: undefined,
			}));
			await logLine(sessionId, params.label, "reply");
			void refreshFleet(ctx);
			watchInBackground(params.label, ctx, params.timeoutMs ?? 1_800_000);
			return {
				content: [{ type: "text" as const, text: `replied to ${params.label}; it is running again and you will be woken at its terminal state` }],
				details: { label: params.label },
			};
		},
	});

	pi.registerTool({
		name: "herd_close",
		label: "herd_close",
		description: "Close a herd agent: ctrl+c ctrl+d, wait for it to disappear, close pane/tab as fallback. Idempotent.",
		parameters: Type.Object({ label: Type.String() }),
		async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
			const { h } = bind(ctx);
			const meta = (await readJson(agentPaths(sessionId, params.label).meta)) as Meta | undefined;
			if (!meta) {
				const outcome = await h.kill(params.label).catch((e: any) => ({ closed: false, via: String(e?.message ?? e) }));
				return { content: [{ type: "text" as const, text: `closed orphan ${params.label} via ${outcome.via}` }], details: outcome };
			}
			const controller = watchers.get(params.label);
			if (controller) {
				controller.abort();
				watchers.delete(params.label);
			}
			const outcome = await h.kill(meta.herdrName, meta.paneId, meta.tabId);
			await removeFile(agentPaths(sessionId, params.label).ask);
			await updateMeta(sessionId, params.label, (current) => ({
				...current,
				state: "closed",
				closedAt: Date.now(),
				exitReason: `close:${outcome.via}`,
			}));
			await logLine(sessionId, params.label, "closed", outcome);
			void refreshFleet(ctx);
			return {
				content: [{ type: "text" as const, text: `closed ${params.label} via ${outcome.via}; still listed = ${outcome.closed ? "no" : "yes"}` }],
				details: outcome,
			};
		},
	});

	// ----------------------------------------------------------------- commands

	async function closeAll(ctx: any) {
		const { h } = bind(ctx);
		for (const label of await listLabels(sessionId)) {
			const meta = (await readJson(agentPaths(sessionId,label).meta)) as Meta | undefined;
			if (!meta) continue;
			const live = await h.sessionPane(meta.piSessionId);
			if (!live) continue;
			watchers.get(label)?.abort(); watchers.delete(label);
			const outcome = await h.kill(meta.herdrName,live.pane_id);
			if (!outcome.closed) { ctx.ui.notify(label + ': 未能关闭，请重试','warning'); continue; }
			await removeFile(agentPaths(sessionId,label).ask);
			await updateMeta(sessionId,label,current=>({...current,state:current.state==='done'?'done':'closed',closedAt:Date.now(),exitReason:'close-all:'+outcome.via}));
		}
		void refreshFleet(ctx);
	}

	pi.registerCommand("herdr", {
		description: "搜索子 agent、跳转窗口、查看结果或关闭任务",
		handler: async (_args, ctx) => {
			try { await openNavigator(ctx,bind(ctx).h,sessionId,()=>closeAll(ctx)); }
			catch (error: any) { ctx.ui.notify(String(error?.message ?? error),'error'); }
		},
	});

	// ---------------------------------------------------------- agent guidance
	// The orchestration contract is versioned with this extension and pushed into the running
	// prompt. It used to live in a user-level AGENTS.md, which cannot follow the installed build.
	// A session without the tools gets nothing: the section is only added when they are live.
	pi.on("before_agent_start", (event) => {
		// Mutating the section is enough; Pi renders the prompt from these options after handlers.
		const guidance = herdGuidance(event.systemPromptOptions);
		if (guidance) event.systemPromptOptions.sections[GUIDANCE_SECTION] = guidance;
		else delete event.systemPromptOptions.sections[GUIDANCE_SECTION];
	});

	// ---------------------------------------------------------------- lifecycle

	pi.on("session_start", async (_event, ctx) => {
		sessionId = ((ctx.sessionManager as any)?.getSessionId?.() as string) ?? "no-session";
		shuttingDown = false;
		bind(ctx);
		if (ctx.hasUI) {
			ctx.ui.setTitle("MAIN");
			try {
				const parent = await bind(ctx).h.sessionPane(sessionId);
				if (parent) {
					await bind(ctx).h.renamePane(parent.pane_id, "MAIN");
					await bind(ctx).h.renameTab(parent.tab_id, "MAIN");
				}
			} catch (error: any) { ctx.ui.notify(`窗口标识未更新: ${error?.message ?? error}`,'warning'); }
		}
		await defs().catch(() => []);
		// Rebuild watchers from disk: a restarted parent must not lose running children.
		for (const label of await listLabels(sessionId)) {
			const meta = (await readJson(agentPaths(sessionId, label).meta)) as Meta | undefined;
			if (!meta) continue;
			if (meta.state === "starting" || meta.state === "running") {
				let alive = await bind(ctx).h.exists(meta.herdrName);
				if (!alive) {
					// A child caught mid-start during the reload is not dead yet: re-check once, and keep a
					// finished result on disk rather than calling a run failed that actually delivered.
					await new Promise((resolve) => setTimeout(resolve, 1_500));
					alive = await bind(ctx).h.exists(meta.herdrName);
				}
				if (!alive) {
					const rescued = await readText(agentPaths(sessionId, label).result);
					await updateMeta(sessionId, label, (current) => ({
						...current,
						state: rescued?.trim() ? "done" : "failed",
						endedAt: Date.now(),
						exitReason: rescued?.trim()
							? "vanished while parent was away; result on disk"
							: "vanished while parent was away",
					}));
					continue;
				}
				watchInBackground(label, ctx, 1_800_000);
			}
		}
		startFleetTimer(ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		shuttingDown = true;
		stopFleetTimer();
		for (const controller of watchers.values()) controller.abort();
		watchers.clear();
		unmountWidget(ctx);
		// `/reload` tears this extension down but brings it straight back with the same session id,
		// and session_start re-attaches to live children. Killing them here threw away whole runs
		// whenever the parent reloaded mid-flight. Only a real quit ends the children.
		const reason = (event as any)?.reason as string | undefined;
		const keepChildren = (loadConfig().keepChildrenOnReload ?? true) && reason === "reload";
		if (keepChildren) {
			try {
				for (const label of await listLabels(sessionId)) {
					await logLine(sessionId, label, "shutdown", { reason, kept: true });
				}
			} catch {
				/* shutdown must never throw */
			}
			return;
		}
		try {
			const { h } = bind(ctx);
			for (const label of await listLabels(sessionId)) {
				const meta = (await readJson(agentPaths(sessionId, label).meta)) as Meta | undefined;
				if (!meta || meta.state === "closed") continue;
				const outcome = await h.kill(meta.herdrName, meta.paneId, meta.tabId).catch(() => ({ closed: false, via: "shutdown-error" }));
				await updateMeta(sessionId, label, (current) => ({
					...current,
					state: current.state === "done" ? "done" : "closed",
					closedAt: Date.now(),
					exitReason: `shutdown:${outcome.via}`,
				}));
			}
		} catch {
			/* shutdown must never throw */
		}
	});
}
