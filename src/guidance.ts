/**
 * Agent-facing orchestration contract.
 *
 * This text ships with the extension and is injected into the running session's system prompt
 * (`before_agent_start`), so it always matches the installed version. It deliberately does not
 * live in a user-level `AGENTS.md`: a global file cannot be versioned with the extension and
 * silently drifts once the installed build changes its tools, defaults, or paths.
 */

import { rootDir } from "./store.ts";

export type PromptToolSelection = {
	/** Tools the model can actually call in this session. */
	selectedTools?: string[];
	/** Selected tools hidden behind another tool; the model has no declaration for them. */
	hiddenTools?: string[];
};

/** True when this session can call the orchestrator tools, so the contract is worth its bytes. */
export function herdToolsActive(options: PromptToolSelection): boolean {
	const selected = options.selectedTools ?? [];
	const hidden = options.hiddenTools ?? [];
	return selected.includes("herd_spawn") && !hidden.includes("herd_spawn");
}

/** Promoted to the model as one tagged system-prompt section; kept as plain text for tests. */
export function guidanceText(runRoot: string = rootDir()): string {
	return [
		"编排契约（由 pi-herdr-orchestrator 扩展注入；不要在 AGENTS.md 里重复这些规则）",
		"",
		"- 工具：herd_spawn / herd_wait / herd_status / herd_steer / herd_reply / herd_close，交互菜单 /herdr。",
		"- 默认主动派活，不等用户点名。以下任一成立就派：活能拆成互不依赖的并行分支；单步要长时间检索或试错而只需摘要结论；需要独立第三方复核（reviewer 看自己刚写的 diff）；实现量明显超过单文件小改。",
		"- 不派的四种：单文件小改（约 20 行内）、纯问答或读状态、需要跨轮次追问的对话、元活（建改角色定义、models.json、配置）。用户说“你自己做”时按用户说的。",
		"- 派活前先 herd_status：roster 每行是 `name (model) — 什么时候用它`。会话内 roster 不变，查一次就够。definition 必填，只接受 roster 里的名字；未知名字直接拒绝，不会被替换成别的角色。",
		"- 任务书一次写全：目标、边界、验收标准、具体文件路径、验证方式。给路径即可——子 agent 自己能 read/bash，不要把文件内容内联进 task。写不全会被任务书门拦下。",
		"- 子 agent 提问会写 ask.json 并停在 blocked（不会自动关闭）；读问题后用 herd_reply 回答，它会继续。交付后 pane 默认自动关闭防孤儿，需要连续追问才传 keepAlive: true。",
		"- 结果是文件契约，不是 pane 文本：result.md 要有结构化章节（完成内容 / 改动 / 验证 / 阻塞 / 剩余）。",
		"- 元活（建改角色定义、models.json、配置）主会话自己做，不派 Agent。角色只读 $PI_CODING_AGENT_DIR/agents/*.md（未设置时为 ~/.pi/agent/agents/*.md），每次派活重读，不需要 reload；扩展内置的 agents/ 只在该目录没有任何 .md 时一次性铺种，之后不合并——删角色就是真删。",
		`- 排障看盘上事实：${runRoot}/runs/<session>/<label>/（meta.json / result.md / ask.json / log.jsonl）。只关闭本主会话核实过归属的 pane；官方关闭挂起就停下报告，不绕过工具用 socket/CLI 强关。`,
		"- 升级后建议等本会话子任务结束再 /reload。/reload 默认保留并重新接管子任务（keepChildrenOnReload 默认 true）；真正退出仍会关闭子任务，keepAlive 不能阻止。不要重载其他会话。", 
		"- 子进程只显式加载官方 herdr-agent-state.ts 与 child-ui.ts（身份/导航），不含编排工具；不要省略官方上报器，否则 session id 无法用于精确跳转。",
	].join("\n");
}

/** `undefined` leaves the prompt untouched: a session without the tools gets no herdr prose. */
export function herdGuidance(options: PromptToolSelection, runRoot?: string): string | undefined {
	return herdToolsActive(options) ? guidanceText(runRoot) : undefined;
}

/** Section name handed to the prompt builder; must match Pi's `^[a-z][a-z0-9_-]*$` rule. */
export const GUIDANCE_SECTION = "herd_orchestration";
