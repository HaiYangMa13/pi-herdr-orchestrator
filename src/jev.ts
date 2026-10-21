/**
 * TypeSafe Jev (System One) gates.
 *
 * API shape verified against https://docs.typesafe.ai/introduction/quickstart.md :
 *   POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <KEY>; {state, model, questions:{id:{type,instructions,criteria}}}
 *   -> {model, answers:{id:{type, choice?, score?, noul?, confidence, probabilities}}}
 *
 * Every gate degrades to a pass-through ({gated:false}) when the key or network is
 * unavailable, so orchestration never depends on Jev being up.
 */

import { loadConfig } from "./config.ts";

function configPathHint(): string {
	return "set jev.apiKey in ~/.pi/agent/pi-herd/config.json or TYPESAFE_API_KEY";
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type Gate = {
	gated: boolean;
	ok?: boolean;
	verdict?: string;
	confidence?: number;
	missing?: string[];
	reason?: string;
};

type Question = { type: "choice" | "noul" | "score"; instructions: string; criteria?: unknown };

export type Jev = ReturnType<typeof createJev>;

type ExecFn = (cmd: string, args: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export function createJev(options: { apiKey?: string; timeoutMs?: number; model?: string; exec?: ExecFn } = {}) {
	const config = loadConfig().jev ?? {};
	const apiKey = options.apiKey ?? config.apiKey ?? process.env.TYPESAFE_API_KEY;
	const timeoutMs = options.timeoutMs ?? config.timeoutMs ?? 20_000;
	const model = options.model ?? config.model ?? "jev-latest";
	const disabled = config.enabled === false;
	const proxy = (options as any).proxy ?? config.proxy ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "";

	let lastError = "";

	async function ask(state: string, questions: Record<string, Question>): Promise<Record<string, any> | undefined> {
		if (!apiKey || disabled) return undefined;
		const body = JSON.stringify({ state, model, questions });
		const args = ["-sS", "--max-time", String(Math.round(timeoutMs / 1000)), "-H", `Authorization: Bearer ${apiKey}`, "-H", "Content-Type: application/json", "-d", body, ENDPOINT];
		if (proxy) args.splice(1, 0, "--proxy", proxy);
		if (options.exec) {
			try {
				const res = await options.exec("curl", args, { timeout: timeoutMs + 5000 });
				const text = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
				const json = text.startsWith("{") ? JSON.parse(text) : undefined;
				if (res.code !== 0 || !json?.answers) {
					lastError = `jev curl exit ${res.code}: ${text.slice(0, 140)}`;
					return undefined;
				}
				lastError = "";
				return json.answers;
			} catch (error: any) {
				lastError = `jev curl failed: ${String(error?.message ?? error).slice(0, 140)}`;
				return undefined;
			}
		}
		try {
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				lastError = `jev http ${res.status}${text ? `: ${text.slice(0, 120)}` : ""}`;
				return undefined;
			}
			const json: any = await res.json();
			lastError = "";
			return json?.answers;
		} catch (error: any) {
			lastError = `jev error: ${String(error?.message ?? error).slice(0, 120)}`;
			return undefined;
		}
	}

	const skipped = (reason: string): Gate => ({ gated: false, reason });

	return {
		available: Boolean(apiKey) && !disabled,
		lastError: () => lastError,

		/** Reject task specs that lack acceptance criteria, paths, or a verification rule. */
		async gateTaskSpec(task: string): Promise<Gate> {
			const answers = await ask(task, {
				missing_acceptance: { type: "noul", instructions: "任务书有遗漏：没有给出可验证的验收标准或明确的完成定义" },
				missing_paths: { type: "noul", instructions: "任务书有遗漏：没有指名具体的文件路径、模块或产出位置" },
				missing_verification_rule: { type: "noul", instructions: "任务书有遗漏：没有给出任何可执行的验证方式或检查步骤（怎么证明真的做完了）" },
			});
			if (!answers) return skipped(!apiKey ? `no jev key (${configPathHint()})` : disabled ? "jev disabled in config" : lastError || "jev call failed");
			const missing: string[] = [];
			for (const key of ["missing_acceptance", "missing_paths", "missing_verification_rule"]) {
				const p = Number(answers[key]?.noul ?? 0);
				if (p >= 0.5) missing.push(key.replace(/^missing_/, ""));
			}
			// acceptance + paths are hard requirements; a missing verification rule is advisory
			const hard = missing.filter((m) => m !== "verification_rule");
			return { gated: true, ok: hard.length === 0, missing };
		},

		/** Classify whether a child's result carries verifiable completion evidence. */
		async gateResult(result: string): Promise<Gate> {
			const answers = await ask(result.slice(0, 40_000), {
				verdict: {
					type: "choice",
					instructions: "判断这份子 agent 的结果报告在多大程度上提供了可核验的完成证据",
					criteria: {
						pass: "包含完成内容、改动文件或产出、验证证据，并区分已验证与未验证",
						needs_more: "有实质工作描述，但缺少验证证据，或缺必需章节，或含糊",
						fail: "空话、只复述任务、只有单字确认（如 READY./done），或没有任何实质产出",
					},
				},
			});
			if (!answers) return skipped(!apiKey ? `no jev key (${configPathHint()})` : disabled ? "jev disabled in config" : lastError || "jev call failed");
			const verdict = answers.verdict;
			return { gated: true, verdict: String(verdict?.choice ?? "unknown"), confidence: Number(verdict?.confidence ?? 0) };
		},

		/** Pick an agent definition; only trusted above 0.4 confidence. */
		async routeDefinition(defs: Array<{ name: string; description: string }>, task: string): Promise<Gate> {
			if (defs.length < 2) return { gated: defs.length === 1, verdict: defs[0]?.name, confidence: 1 };
			const criteria: Record<string, string> = {};
			for (const d of defs) criteria[d.name] = d.description || d.name;
			const answers = await ask(task, {
				definition: { type: "choice", instructions: "选择最适合执行该任务的一个 agent 定义", criteria },
			});
			if (!answers) return skipped(!apiKey ? `no jev key (${configPathHint()})` : disabled ? "jev disabled in config" : lastError || "jev call failed");
			const pick = answers.definition;
			const confidence = Number(pick?.confidence ?? 0);
			if (confidence < 0.4) return { gated: false, reason: `low routing confidence ${confidence.toFixed(2)}`, confidence };
			return { gated: true, verdict: String(pick?.choice ?? ""), confidence };
		},
	};
}
