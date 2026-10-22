# pi-herdr-orchestrator

Subagent orchestration for the [Pi coding agent](https://pi.dev), built on [herdr](https://herdr.dev) panes.

Every subagent is a real Pi session in a real terminal pane you can watch, attach to, and scroll. Results come back through files and wake the parent session — no polling loops, no screen scraping, no stale pane handles.

## Why panes

An in-process subagent is invisible until it finishes. This extension takes the opposite stance: each subagent gets a pane, a shell, and a written contract, so a stuck agent is something you can see instead of something you infer from silence.

- **Visible work** — `herdr` tab holds one pane per subagent; the shared tab is bound to the parent's workspace.
- **File-based results** — the child writes `result.md`; the parent reads it. A crashed pane never loses a finished report.
- **Contract in the prompt** — five required sections: what was done, files changed, verification level, blockers and risks, remaining work.
- **Structured wakeups** — the parent session is woken with a classified outcome (`done`, `blocked`, `no_result`, `failed`, `timeout`), not raw terminal text.

## Install

```bash
pi install npm:pi-herdr-orchestrator
```

Prerequisites:

1. [herdr](https://herdr.dev) running, with its Pi integration installed: `herdr integration install pi`.
2. Pi ≥ 0.60.

Local development:

```bash
git clone <this repo> ~/code/pi-herdr-orchestrator
ln -s ~/code/pi-herdr-orchestrator ~/.pi/agent/extensions/pi-herdr-orchestrator
```

## One entry point: `/herdr`

Available in both the parent session and subagent panes.

- Bottom-docked selector that renders in the editor area, so it never fights terminal images or overlays.
- The main list shows only live or retained subagents; finished work is folded into `📁 Archive (N tasks)`.
- `Enter` focuses a subagent's pane, or opens its report when the pane is gone. `Esc` returns.
- `✕ Close all subagents` sits at the end of the list and asks for confirmation.
- In a subagent pane, the first row returns you to the main session.

Activity card above the editor (`Tasks`): `⠏` running, `?` blocked, `+` done, `!` no result, `x` failed. Rows for successful runs that already exited are dropped after 30 seconds; blocked and failed rows stay until handled.

## Tools

| Tool | Purpose |
|---|---|
| `herd_spawn` | Start a subagent: `task`, optional `definition`, `cwd`, `files`, `async`, `keepAlive`, `timeoutMs` |
| `herd_status` | Snapshot of every subagent for this parent session |
| `herd_wait` | Block until a subagent reaches a terminal state |
| `herd_steer` | Send additional direction to a running subagent |
| `herd_reply` | Answer a subagent's question and resume it |
| `herd_close` | Close a subagent's pane (idempotent) |

Subagents get no orchestration tools, so delegation cannot nest.

## Roles

Agent definitions live in `~/.pi/agent/agents/*.md` and are re-read on every spawn — adding a role takes effect immediately, no reload.

```markdown
---
name: designer
description: UI/UX layout and frontend styling.
model: local-cpa/gpt-6.1-sol
thinking: high
tools: [read, grep, find, ls, bash, edit, write]
---

You own only the explicitly assigned UI surface...
```

- A user file wins over the packaged default of the same name; omitted `model` / `thinking` / `tools` / body fall back to the packaged version.
- `description` is what the Jev router matches on when `definition` is omitted.
- Packaged defaults: `scout`, `worker`, `reviewer`. Yours may add `implementer`, `generalist`, `researcher`, `frontend-designer`, or anything else.

## Jev gates (optional)

With [TypeSafe Jev](https://console.typesafe.ai) configured, three narrow classification calls run per handoff:

1. **Task gate** — reject a task that has no acceptance criteria or no output path, before spending a pane on it.
2. **Role router** — pick the definition when `definition` is omitted.
3. **Result gate** — flag a result that claims success without evidence (a lone `READY.` is not a report).

Without an API key all three degrade to pass-through; a deterministic lint still flags empty or placeholder results.

```json
{
  "jev": {
    "apiKey": "sk-...",
    "model": "jev-latest",
    "enabled": true,
    "proxy": "http://127.0.0.1:7890"
  }
}
```

Config lives at `~/.pi/agent/pi-herdr/config.json` (override the root with `PI_HERDR_ROOT`). `proxy` is honoured through `curl`, since Node's `fetch` ignores `HTTP_PROXY`.

## Layout on disk

```text
~/.pi/agent/pi-herdr/
├── config.json
└── runs/<parentSessionId>/<label>/
    ├── meta.json     # state, pane id, herdr name
    ├── task.md       # the handed-off task
    ├── log.jsonl     # lifecycle events
    ├── ask.json      # present while blocked on a question
    └── result.md     # written by the subagent
```

When a subagent misbehaves, read `meta.json` and `log.jsonl` before guessing.

## Notes and limits

- A subagent that ends its turn without writing `result.md` is asked once to dump the report ("rescue") and gets `rescueMs` (default 180000) to do it before the pane is closed. Set `rescueMs: 0` to disable.
- A wait budget (`timeoutMs`, default `1800000` = 30 min) is the caller's, not a global rule: when it expires the run is classified `timeout`, rescued, then closed.
- `/reload` keeps that session's subagents running and re-attaches to them on the way back (`keepChildrenOnReload`, default true). A real quit still closes them, even with `keepAlive: true`.
- In `pi -p` (non-interactive) mode, `async: true` subagents are killed when the parent exits. Use `async: false` there.
- A subagent that only replies `READY.` gets classified as `no_result` — write the report to `result.md`.

## Development

```bash
npm test          # unit + lifecycle tests
npm run test:herdr  # opt-in: real herdr panes, parent/child navigation, no model calls
```

`DESIGN.md` records the design and an appendix of assumptions that real runs disproved.

## 中文速览

```bash
pi install npm:pi-herdr-orchestrator
herdr integration install pi
```

- `/herdr`：底栏选单，只列活跃/保留子任务，历史进 `📁 Archive`；可跳 pane、返回主窗口、确认后全部关闭。
- 子 agent 结果写 `result.md`，父会话读到终态后自动唤醒；`blocked` 保活，用 `herd_reply` 回答后继续。
- 角色定义放 `~/.pi/agent/agents/*.md`，每次派活重读，无需 reload。
- `/reload` 会关闭本会话的子 agent；`pi -p` 场景用 `async: false`。

## License

MIT
