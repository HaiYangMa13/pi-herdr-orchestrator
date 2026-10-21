# pi-herdr — 基于 herdr 的自建编排层

> v0.2 更新：现行行为以 README.md 为准。唯一命令 `/herdr`，搜索/跳转/结果查看/确认关闭集成在菜单内；MAIN/SUB 身份条与共享 AGENTS tab 已实现。子 agent 显式加载官方状态上报器和 child-ui.ts，但不加载编排工具。旧目录与数据通过兼容链接保留。下文保留初版设计与实测记录，不代表所有旧假设仍成立。

目标：在 pi extension 标准内实现一个比 `pi-herdsman` 更可靠的子 agent 编排层，并接入 TypeSafe **Jev** 做窄幅判定。
验收目标：避免旧 settling 探针循环，降低孤儿 pane 与版本错配风险。不能把设计目标视为已证明的零故障保证，须以回归测试和实际运行验证。

## 0. 硬性约束（违反即失败）

1. **禁止 `herdr pane run "echo ..."` 做任何就绪/存活探测。** 子 agent 的 pane 前台是 `pi`，往里打 echo 会被模型当成用户提问，形成无限 ping-pong（herdsman 的原罪）。
2. **结果只从文件读，不从 pane 文本读。** 子 agent 的最终结果写入 `result.md`；pane 文本仅作兜底诊断。
3. **不硬编码任何超时猜 shell。** 完成判定只用 `herdr agent wait --until done|blocked|unknown`。
4. 子 agent 使用 `--no-extensions --no-skills` 禁止自动发现，仅显式加载 herdr-agent-state.ts 与 child-ui.ts；不注册 `herd_*` 工具（子无委派权）。
5. 所有 herdr 调用走 `pi.exec("herdr", [...])`（argv 数组，不拼 shell 字符串）。
6. 扩展在 `session_start` 才启动定时器/后台资源，`session_shutdown` 里幂等清理。

## 1. herdr 原语（只用这些）

| 用途 | 命令 |
|---|---|
| 建 pane | `herdr pane split --cwd <dir> --json` → 取 `pane_id` |
| 等 shell | `herdr agent start <name> --kind pi --pane <id> --timeout 30000 -- [pi 参数...]`（herdr 自己验就绪） |
| 投递任务 | `herdr agent prompt <name> <text> --wait --until working --timeout 60000` |
| 等完成 | `herdr agent wait <name> --until done --until blocked --until unknown --timeout <ms>` |
| 读屏（仅诊断） | `herdr agent read <name> --lines 200` |
| 关 | `herdr agent send-keys <name> ctrl+c ctrl+d` → `herdr agent wait --until done --timeout 10000` → `herdr agent list` 确认消失 → 必要时 `herdr pane close <id>` |
| 列 | `herdr agent list`（JSON，取 name/pane_id/agent_status） |

子进程启动参数固定为：
```
pi --model <provider/id:thinking> --thinking <level> --tools <csv> \
   --no-extensions --no-skills --approve --name "herd:<label>" --session-id <uuid>
```

## 2. 状态与文件布局（崩溃安全）

```
~/.pi/agent/pi-herd/
  config.json                     # 可选覆盖：jev 开关、默认超时
  runs/<runId>/                   # runId = 父 pi session id
    <label>/
      meta.json                   # {label, definition, paneId, herdrName, piSessionId, startedAt, state, exitReason}
      task.md                     # 投递给子 agent 的任务正文（唯一事实源）
      result.md                   # 子 agent 写的最终结果（缺失 = no_result）
      ask.json                    # 子 agent 提问时写
      log.jsonl                   # 本层自己的状态流转日志
```

状态机：`starting → running → (done | blocked | no_result | failed | closed)`。
所有状态只从磁盘推导；进程内存里不保留权威状态。

## 3. 工具面（namespace `herd`）

| 工具 | 参数 | 行为 |
|---|---|---|
| `herd_spawn` | `definition, label?, task, files?[], async?=true` | 过 Jev 任务书门 → 建 pane → 起 pi → 投递 → 返回 `{label, paneId, state}`；`async` 时立即返回 |
| `herd_wait` | `label, timeoutMs?` | `agent wait` 到终态 → 读 `result.md` → 过 Jev 结果门 → 返回结构化结果 |
| `herd_status` | — | 磁盘 + `herdr agent list` 合并视图：label / state / 已运行时长 / 有无 result |
| `herd_steer` | `label, message` | `agent prompt --wait --until working`；返回是否被接受 |
| `herd_reply` | `label, answer` | 回答 `ask.json`（`agent prompt`），清 ask 标记 |
| `herd_close` | `label` | 见 §1 关闭流程；幂等；无论 pi 是否退出一律 `pane close` 兜底 |

命令：仅 `/herdr`（搜索导航、结果查看、返回主窗口；主会话菜单含确认后的全部关闭）。

异步唤醒：`herd_spawn(async)` 后由 session 级 poller 调 `agent wait`，终态时
`pi.sendMessage({customType:"herd-agent-result", content, display:true}, {triggerTurn:true})`
唤醒父会话（等价于 herdsman 的 `pi-herdsman-agent-result`）。

## 4. 任务书模板（写入 task.md 并投递）

投递文本 = 契约头 + `task.md` 路径 + 任务正文。契约头固定包含：

```
你是 <definition>，只执行本次分配，不委派。
最终结果必须写入：<resultPath>（Markdown，包含：完成内容 / 改动文件 / 验证程度 / 阻塞与风险 / 剩余工作）
需要 owner 决策时：把问题写入 <askPath>（JSON {question, options})，然后停止，不要猜测。
禁止只回复 READY./done 之类的单字结束；禁止在没有任何文本总结时结束回合。
```

## 5. Jev 接入（可选，缺 API key 时全部降级为 no-op 并记警告）

客户端：`POST https://api.typesafe.ai/v1/systemone`，body `{ state, questions: {...} }`，
返回带类型的答案 + 置信度；key 取 `TYPESAFE_API_KEY`。**请求/响应精确 shape 以实现前
`curl` 官方文档核对为准**（`https://docs.typesafe.ai/`），不得凭记忆编造字段。

三个判定点：

1. `gateTaskSpec(task)` → `{pass, missing: string[]}`：是否含验收标准、是否指名文件路径、
   是否禁止无验证声称通过。不 pass → `herd_spawn` 直接返回错误，要求补任务书。
2. `gateResult(resultText)` → `{verdict: "pass"|"fail"|"needs_more", confidence}`：
   区分"真做完"与"空话/假完成"。`fail`/`needs_more` 在结果里显式标注，不阻断。
3. `routeDefinition(taskText)` → `{definition, confidence}`：从 `agents.json` 的候选里选。
   仅在调用方未指定 definition 且置信度 ≥ 阈值时采用，否则报错要求显式指定。

判定点失败（网络/超时/Jev 报错）必须**降级放行**并标注 `gated: false`，绝不因 Jev 不可用而阻塞编排。

## 6. Agent 定义

`/root/code/pi-herdr/agents/*.md`，最小 frontmatter：`name, model, thinking, tools(csv), description`，
body 即 system prompt 追加段。自带：`scout`（read/grep/find/ls）、`worker`（+bash/edit/write）、
`reviewer`（只读）。`agents.json` 由构建脚本从 md 生成，供 `routeDefinition` 使用。

## 7. 与非目标

- 不做 Manager/Chief/项目 assignment/worktree 回收那套治理。
- 不做跨机（远端 ssh）agent；先本机。
- 不接管 `pi-herdsman`：MVP 期两者共存但**不派活给 herdsman**；验收通过后再卸载。

## 8. 验收（必须实跑，不可推断）

在临时目录 `/tmp/herd-accept/` 执行，全程记录命令与输出：

1. `pi --extension /root/code/pi-herdr/index.ts` 起一个会话，`herd_spawn` 一个 `scout`，
   结果写入 `result.md` 且父会话被唤醒（`herd-agent-result`）。
2. 诱发一次 `ask.json`（任务里要求它提问），`herd_reply` 后能继续到终态。
3. `herd_close` 后：`herdr agent list` 无该 agent，`herdr pane process-info` 不是 pi，
   进程表无残留 pi。
4. 反例：任务书缺验收标准时 `herd_spawn` 被 Jev 门拦下（有 key）或标注 `gated:false`（无 key）。
5. 反例：故意让子 agent 只输出 `READY.`，`gateResult` 判 `fail` 或 `no_result` 被正确上报。
6. 全程零 `pane run echo`：`grep -c 'pane.*run' src/` = 0。

---

## 附录 A — 实测修正（2026-10-20，全部来自真实运行，不是推断）

| 原设计 | 实测结论 | 修正 |
|---|---|---|
| 完成判定用 `agent wait --until done` | **错**。pi agent 结束一轮只进入 `idle`，`done` 只在进程退出时出现；用 done 会 150 秒超时空等 | 改为 `--until idle --until done --until blocked --until unknown`；已在 idle 时 `wait` 28ms 立即返回 |
| 就绪探测 | `herdr agent start` 自带 `interactive_ready: true`（默认等 30s） | 已完全去掉任何 `pane run echo` |
| 子 agent 只读也能交结果 | **错**。结果文件需要写权限；只挂 `read` 的子 agent 无法产出 | 所有定义都带 `write`（仅允许写结果文件） |
| 交付后 agent 可复用 | 复用 = 孤儿 pane 风险 | 默认 `keepAlive:false`，终态后自动 `ctrl+c ctrl+d` 关闭 |
| — | **新发现的坑**：`blocked`（子 agent 提问）时若自动关闭，`herd_reply` 必然 `agent_not_found` | `blocked` 状态**不**自动关闭；`herd_reply` 后重新挂 watcher |
| 结果质量靠 Jev | 无 `TYPESAFE_API_KEY` 时 Jev 全部降级，`READY.` 之类假完成会漏过 | 增加确定性 lint（单字确认 / <120 字符 / 缺 3 份章节）→ `verdict: suspect`，不依赖 Jev |

### 已验证的完整链路（父会话被唤醒两次，全程 57 秒）

```
09:31:16 pane wD:p1E 建立
09:31:21 prompt 投递
09:31:41 terminal:blocked  ← ask.json 出现，父会话唤醒
09:31:45 reply             ← 父会话自己调 herd_reply
09:32:04 terminal:done     ← 父会话再次唤醒
09:32:13 closed via agent-exited
```
