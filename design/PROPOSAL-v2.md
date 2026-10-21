# pi-herd 终端子 Agent 多窗格架构与命令选单设计提案 (v2)

本文档针对 `pi-herd` 在终端宿主环境（herdr / tmux 协同工作区）中的窗口身份隔离、多子 Agent 共享窗格布局、以及快速检索命令选单（`/herdr`）提出规范设计方案。

配套交付的独立离线交互原型：`/root/pi-herd/design/prototype-v2.html`。

---

## 1. 设计背景与核心对标 (Conceptual Inspirations)

本方案立足于**终端原生（Terminal-Native）**的高密度、低干扰体验，拒绝把终端包装成臃肿的 SaaS 仪表盘。方案从现代开发工具体系中汲取核心概念灵感：
- **VS Code Quick Open / Command Palette**：统一的即席检索入口，支持键盘上下穿梭与快速跳转，用完即走，无害恢复上下文；
- **Linear List Density**：高信息密度排版、状态优先级显式排序（Running > Blocked > Done）；
- **tmux Pane Titles & Borders**：清晰的窗格身份切分与焦点边框，避免多窗格环境下的认知混淆。

> **规范声明**：
> 1. 当前宿主环境实际生产命令为 `/herd`；本提案提出的 `/herdr` 仅作为交互原型中的快速检索与直达别名提案（尚未合入生产扩展代码）。
> 2. 原型中演示的窗口跳转与结果检视为交互仿真规范，不声称具备生产运行时的实时进程接管控制。

---

## 2. 窗口身份与层级隔离规范 (Workspace & Pane Identity)

为彻底解决主会话（MAIN）与子 Agent 窗格（SUB）混淆的问题，herdr 终端外壳采用两级身份隔离体系：

### 2.1 顶级工作区标签页 (Workspace Tabs)
- **`MAIN · redock-ohos`**：
  主会话独占 Tab。负责核心编排逻辑、用户交互与全局任务派发；包含主会话编辑器与位于编辑器上方的活动挂件（FleetView）。
- **`AGENTS · s_8a2f`**：
  同一父会话（`s_8a2f`）下的**所有子 Agent 共享一个独立 Tab**。该 Tab 内部切分为多个独立 Subagent Pane，数量徽标与存活子 Agent 数量实时联动。

### 2.2 窗格级独立命名与焦点指示 (Pane Titling & Focus Badges)
- **主窗格标题**：
  `MAIN · redock-ohos · GPT 6.1 Sol high · parent s_8a2f`
- **子窗格独立标题**：
  `SUB · <task-label> · <role> · parent <short-session>`
  例如：`SUB · download-tests · scout · parent s_8a2f`
- **文字形式的双重焦点指示（Not Color Alone）**：
  终端遵循可访问性与不同色阶终端兼容规范，禁止仅依赖边框颜色来识别焦点：
  - 聚焦窗格（Focused）：高亮蓝色外框 + **文字徽标 `[FOCUSED]`**；
  - 非聚焦窗格（Unfocused）：暗色细边框 + **文字徽标 `[PANE]`**；
  - 点击窗格任意区域即可即时切换聚焦。
- **永久身份保留**：
  即使活动条中所有任务衰减消失，外壳标签页与各窗格标题栏依然永久固化父子身份（MAIN vs SUB），杜绝迷失。

---

## 3. `/herdr` 快速检索命令面板交互规范 (Command Palette Specification)

### 3.1 呼出与键盘导航
- **呼出路径**：
  1. 终端提示符直接键入 `/herdr` 或 `/herd` 按回车；
  2. 全局快捷键 `Ctrl+P` / `⌘P`；
  3. 点击窗口右上角轻量按钮 `/herdr 选单`。
- **键盘焦点陷阱与无害退出**：
  - 呼出时自动聚焦搜索输入框，捕获 `Tab`、`↑`、`↓`、`Enter`、`Esc`；
  - 按 `Esc` 或点击遮罩退出时，无害恢复唤起前的光标与组件焦点；
  - 键盘事件仅在弹窗开启时生效，关闭状态下绝不劫持用户在终端编辑区的正常字符输入。

### 3.2 过滤作用域与列表项动作路由
命令列表严格限定于当前父会话（`s_8a2f`）与工作区（`redock-ohos`）：

| 任务当前状态 | 面板操作标识 | 触发响应行为 (Enter / Click) |
| :--- | :--- | :--- |
| **返回主会话** | `[返回主会话]` | 切换到 `MAIN · redock-ohos` 标签页，聚焦主编辑区 |
| **运行中 (`⠏`) / 阻塞待答 (`?`)** | `[进入窗口]` | 自动切换到 `AGENTS · s_8a2f` 共享 Tab，立即聚焦该子 Pane 并展示 `[FOCUSED]` 标识 |
| **已交付完成且 Pane 关闭 (`+`)** | `[查看结果]` | **坚决不产生虚假空跳转**；直接弹出 `result.md` 交付报告与元数据详情抽屉 |

---

## 4. 生命周期管理与防孤儿机制 (Lifecycle & Grace Period)

1. **交付后自动关闭 Pane**：
   子 Agent 完成任务并产出结果后，默认自动关闭自身终端窗格，状态标记为 `CLOSED`，防止孤儿进程与僵尸窗格霸屏。
2. **30 秒留存衰减期 (30s Retention)**：
   任务完成进入 `done` 状态后，在编辑器上方的活动挂件中保留 30 秒倒计时展示（如 `产出就绪 (留存 26s)`），给开发者即时反馈；30 秒后自动卸载该行。
3. **活动挂件零高度自动折叠**：
   当所有活跃/留存任务清空时，挂件整体卸载，将垂直屏幕空间 100% 交还终端历史流。
4. **历史账本零丢失**：
   挂件中隐退的任务依然在 `/herdr` 快速检索面板中可查，随时可通过“查看结果”调阅落盘的 `result.md` 与 `meta.json`。
5. **后台完成不抢焦点**：
   子 Agent 在后台执行完毕、关闭 Pane 或衰减隐退时，严禁自动抢夺或切换用户当前的 Tab 焦点。

---

## 5. 窄屏自适应与字符几何对齐规范 (Geometry & Viewports)

- **单宽列符号约束**：
  状态指示仅采用单宽字符（运行 `⠏`、阻塞 `?`、完成 `+`、错误 `x`、关闭 `.`），坚决不使用 Emoji，保障跨终端几何对齐。
- **三档视口响应能力**：
  - `100 列（宽屏）`：3 列并行子窗格分屏；
  - `80 列（经典标准）`：单列紧凑排版，隐藏长文本描述，窗格自动纵向重排；
  - `48 列（超窄终端）`：精简次要徽标，保留核心 `MAIN`/`SUB` 身份标与状态符号，完全无水平溢出。

---

## 6. 交付物验收与验证记录

- **交互原型文件**：`/root/pi-herd/design/prototype-v2.html`
- **规范提案文件**：`/root/pi-herd/design/PROPOSAL-v2.md`
- **测试验证**：
  - 提取 inline JavaScript 通过 Node.js v22 语法严格校验 (`node -c` 通过)；
  - Gemini 初稿未做浏览器验证；主会话随后使用 Windows 独立 headless Edge 实测，完成主/子窗口与菜单截图。
  - `node design/test-v2-browser.mjs` 通过：搜索+Enter 跳入目标 pane 且 DOM 焦点同步；Esc 恢复焦点；空搜索结果；返回主会话；关闭任务查看结果；30 秒收起后仍可查看历史；后台完成不切 tab；460px 窄屏无页面水平溢出。
  - 复核修正：菜单跳转不再把焦点恢复到隐藏的主输入框；按 workspace/parent 过滤候选；已关闭 pane 从子 tab 移除；长角色名不挤压状态列。
  - 截图：`v2-main.jpg`、`v2-subagents.jpg`、`v2-palette.jpg`、`v2-narrow.jpg`。以上均为原型测试，不代表 Pi/herdr 生产控制已实现。
