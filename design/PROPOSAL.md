# pi-herd 终端子任务挂件设计提案 (Terminal Activity Widget Proposal)

本文档针对 `pi-herd` 在 Pi 编码 Agent 终端宿主环境中的子任务状态挂件（`FleetView`，位于编辑器上方 `placement: "aboveEditor"`）提出重构设计方案与精确终端排版规范。

配套交付的独立离线交互原型位于：`/root/pi-herd/design/prototype.html`。

---

## 1. 现状痛点与重构动因 (Problem Statement)

通过审视当前 `/root/pi-herd/index.ts`（第 80–325 行）的实现与实际运行表现，现存终端挂件存在以下核心设计与可用性缺陷：

1. **常驻封闭外框浪费垂直空间**：
   - 当前实现使用全包围圆角框线（`╭── herd ... ──╮` 与 `╰──────────╯`，左右两侧为 `│`），无论内部有多少行，强制增加额外的顶框行、底框行以及左右两侧边框列。
   - 在寸土寸金的终端窗口中，尤其是当用户在底部编辑器输入或查看上下文转录时，多余的装饰边框造成了严重的纵向空间浪费。
2. **已完成任务僵尸霸屏（6 任务占满 8 行）**：
   - 当前实现将所有状态（包括 `done`）无差别持久保留在数组中。例如 `download-tests`、`git-rename`、`git-untracked`、`sftp-image`、`terminal-color`、`theme-contrast` 等 6 个早已完成的任务会永久停留在屏幕中央。
   - 开发者无法聚焦于“当前正在发生什么”，反而被历史沉渣遮挡。
3. **状态描述单一泛化（Generic `result`）**：
   - 当前所有交付的任务一律显示灰色的 `result` 字符串，无法传达具体完成特征、错误原因或需要人工决策的上下文。
4. **会话重载与冷启动污染**：
   - 当会话重新加载或重启时，扩展重新扫描磁盘读取所有 `meta.json`，把过去的完成状态全数重新拉回屏幕，使得终端挂件从未处于清洁状态。
5. **窄屏对齐鲁棒性差**：
   - 在 40 列等狭窄终端视口下，原有固定列宽（`labelW + defW + flagsW`）很容易发生溢出或折行，破坏 TUI 美观。

---

## 2. 核心设计哲学与业界标杆对标 (Design Rationale & References)

本提案结合现代开发者工具的三大核心设计典范，提出“**活动优先（Activity-First）、紧凑无框、优雅衰退**”的 TUI 设计体系：

### 2.1 Linear：任务列表密度与状态优先级 (Linear Priority & Density)
- **优先级动态排队**：
  挂件仅服务于“当前需要关注的活动”，任务依状态权重严格排序：
  $$\text{Running / Starting (0)} \succ \text{Blocked / ASK (1)} \succ \text{Failed / Timeout / No\_Result (2)} \succ \text{Just Done (3)}$$
  - 运行中的任务置顶，让开发者对后台 Agent 并行状态一目了然；
  - 阻塞待答（`ASK`）排在最前列显眼位置，提醒人工介入；
  - 已完成项降权沉底，弱化显示。
- **严格展示配额（Max 5 Active Rows）**：
  活动挂件最多展示 5 行活跃任务。超过 5 个任务时，底部展示聚合行：`... 还有 N 个任务 (/herd)`，彻底根除垂直高度无底线膨胀的问题。

### 2.2 VS Code：静默渐隐与瞬态生命周期 (VS Code Unobtrusive Progress)
- **30 秒留存衰减窗口（30-Second Transient Grace Period）**：
  任务完成（`done`）后，给予人类开发者 30 秒的“完成确认窗口”。在此期间展示具体的产出提示及剩余留存倒计时（如 `产出就绪 (余18s)`），30 秒后自动从活动条卸载注销。
- **零占用自动卸载（Zero-Height Auto Unmount）**：
  当所有任务完成且超出 30 秒、或无活动任务时，整个挂件自动调用 `ctx.ui.setWidget("pi-herd-fleet", undefined)` 完全卸载，不留任何空白行与边框，将 100% 垂直屏幕交还给编辑器与对话历史。
- **会话重载冷启动零污染**：
  重启或重载会话时，过滤机制主动跳过所有已完成项（`done`），只有仍存活的运行任务或待解决的错误/阻塞任务才会被挂载，杜绝“僵尸任务复活”。
- **展示生命周期与数据持久化严格解耦**：
  挂件从屏幕隐退绝不代表删除数据。磁盘上的 `runs/<session>/<label>/`（含 `meta.json`、`result.md`、`ask.json`、`log.jsonl`）永久保留，随时可通过 `/herd` 命令呼出全量审计账本。

### 2.3 GitHub Actions：显式异常与单列宽状态标 (Explicit Failure & Single-Width Markers)
- **严格遵循终端单宽列约束（Single-Width Constraint）**：
  坚决不用 Emoji（Emoji 在不同终端字体下存在半角/全角歧义，极易导致整行对齐错位）。所有状态指示符一律限定为 **单列宽** 的 Braille 或 ASCII 字符：
  - 运行中：`⠏` 或 `⠋`（单宽盲文字符，Accent 亮蓝）
  - 等待决策：`?`（ASCII 单宽字符，Warning 琥珀黄）
  - 交付完成：`+`（ASCII 单宽字符，Success 翠绿）
  - 超时/无产出：`!`（ASCII 单宽字符，Destructive 橙红）
  - 异常失败：`x`（ASCII 单宽字符，Destructive 亮红）
  - 归档关闭：`.`（ASCII 单宽字符，Muted 灰度）
- **具体语义化中文状态（Specific Status Labels）**：
  用 `运行中`、`提问待答 ASK`、`产出就绪`、`超时中断`、`异常退出 (code 1)` 等明确描述替代模糊的 `result`。

---

## 3. 终端布局与字符级排版规格 (Exact Terminal Mockups & Geometry)

摒弃传统封闭卡片式边框（无左右 `│` 竖线、无包围角标），采用现代化 **单行分界表头（Compact Rule Header）+ 缩进数据行** 的极简单列流布局。

### 3.1 80 列宽屏规范 (Wide Layout: 80 Columns)

#### 3.1.1 字符预算分配 (Character Budget - 80 Cols)
```text
[Mark 2列] [Label 16列] [Def 8列] [Dur 6列] [2格间距] [Status 描述 20-30列] [右侧留白]
总计预算严格控制在 <= 80 列，无折行风险。
```

#### 3.1.2 场景 1：混杂状态 Mockup (Mixed: 运行中 + 阻塞 + 刚完成)
```text
── 子任务 pi-herd · 2 运行 · 1 待决 · 1 完成 ─────────────────────── /herd 详情 ──
 ⠏  download-tests    scout          12s  运行中 (测试抓取)
 ?  schema-sync       worker       1m05s  提问待答 ASK
 +  git-rename        scout           4s  产出就绪 (余24s)
 ⠏  build-api         worker         35s  运行中 (路由绑定)
 +  git-untracked     scout           6s  产出就绪 (余16s)
 ··· 还有 1 个任务 (输入 /herd 查看全部)
```

#### 3.1.3 场景 2：告警与异常状态 Mockup (Attention / Error States)
错误与阻塞任务绝不自动淡出，保持警示直至开发者处理：
```text
── 子任务 pi-herd · 1 待决 · 3 异常 ──────────────────────────────── /herd 详情 ──
 ?  schema-sync       worker       2m10s  提问待答 ASK
 !  sftp-image        scout        5m00s  超时中断 5m
 x  terminal-color    scout          18s  异常退出 (code 1)
 !  theme-contrast    scout          32s  无产出退出 (empty)
```

#### 3.1.4 场景 3：全量刚完成 Mockup (All Completed Just Now)
对标原版 6 个完成任务霸屏场景。新方案清晰标出留存倒计时，且最多展示 5 行：
```text
── 子任务 pi-herd · 6 完成 ────────────────────────────────────────── /herd 详情 ──
 +  download-tests    scout          12s  产出就绪 (余28s)
 +  git-rename        scout           4s  产出就绪 (余24s)
 +  git-untracked     scout           5s  产出就绪 (余20s)
 +  sftp-image        scout          22s  产出就绪 (余15s)
 +  terminal-color    scout           8s  产出就绪 (余10s)
 ··· 还有 1 个任务 (输入 /herd 查看全部)
```

#### 3.1.5 场景 4：30秒后/空闲态 Mockup (After 30s / Idle)
30 秒衰减期结束后，整个挂件自动卸载，**高度为 0 行**。终端转录直接无缝衔接底部编辑器：
```text
❯ pi 派发子 agent 审核代码库重命名与测试套件
pi: 已调用 herd_spawn 委派子任务。主 agent 继续就绪。
[子任务全部完成，产出已就绪并归档至 disk]

❯ 输入任务指令或委派新 Agent... █
[Tab] 补全  [Enter] 执行  [/herd] 完整诊断表            herd 0↑ 0? 6✓ · main
```

#### 3.1.6 场景 5：`/herd` 全量历史诊断表输出 Mockup (Full Diagnostic Table)
当用户输入 `/herd` 时，完整展示所有已完成与历史任务，证明数据无损留存：
```text
herd agents (session s_8a2f):
+ download-tests · scout · disk=done · herdr=gone · 12s · result=yes · exit:0 (auto-closed)
+ git-rename     · scout · disk=done · herdr=gone ·  4s · result=yes · exit:0 (auto-closed)
+ git-untracked  · scout · disk=done · herdr=gone ·  5s · result=yes · exit:0 (auto-closed)
! sftp-image     · scout · disk=timeout · herdr=gone · 5m00s · result=no · exit:timedOut
x terminal-color · scout · disk=failed · herdr=gone · 18s · result=yes · exit:code:1
! theme-contrast · scout · disk=no_result · herdr=gone · 32s · result=no · exit:empty
? schema-sync    · worker · disk=blocked · herdr=blocked · 1m05s · ask=YES · waiting answer
⠏ build-api      · worker · disk=running · herdr=working · 35s · result=pending
```

---

### 3.2 40 列窄屏规范 (Narrow Layout: 40 Columns)

在 40 列窄屏下，空间极为受限。本设计制定严格的字符截断与自适应省略策略：
- **Label 策略**：超出 10 字符截断并追加 `..`，分配宽度 11 列；
- **Def 策略**：截取前 6 字符，分配宽度 6 列；
- **Dur 策略**：右对齐分配 4 列；
- **Status 描述**：使用精简短语（如 `就绪(24s)`、`待答 ASK`、`运行中`），分配 10 列。

#### 3.2.1 字符预算分配 (Character Budget - 40 Cols)
```text
[Mark 2列] [Label 11列] [Def 6列] [Dur 4列] [1格] [Status 12-14列] = 36-38 列 <= 40 列
```

#### 3.2.2 40 列窄屏 Mockup

**场景 1：混杂状态**
```text
─ 子任务 · 2运行 1待决 ───────── /herd ─
⠏ downlo..   scout   12s 运行中
? schema..   worker 1m05 待答 ASK
+ git-re..   scout    4s 就绪(24s)
⠏ build-..   worker  35s 运行中
+ git-un..   scout    6s 就绪(16s)
··· +1 更多 (/herd)
```

**场景 2：告警与异常状态**
```text
─ 子任务 · 1待决 3异常 ───────── /herd ─
? schema..   worker 2m10 待答 ASK
! sftp-i..   scout  5m00 超时中断
x termin..   scout   18s 异常退出
! theme-..   scout   32s 无产出
```

**场景 3：全量刚完成状态 (倒计时中)**
```text
─ 子任务 · 5完成 ─────────────── /herd ─
+ downlo..   scout   12s 就绪(28s)
+ git-re..   scout    4s 就绪(24s)
+ git-un..   scout    5s 就绪(20s)
+ sftp-i..   scout   22s 就绪(15s)
+ termin..   scout    8s 就绪(10s)
··· +1 更多 (/herd)
```

---

### 3.3 语义颜色与 ANSI 样式映射 (Color Specifications)

遵循 Pi 主题机制（`theme.style(text, { fg, bold })`）与 Dark Mode (OLED) 调色规范：

| 状态类型 | 符号 Mark | 状态文案 Status | 推荐色彩 | ANSI 语义变量 | 说明 |
| :--- | :---: | :--- | :--- | :--- | :--- |
| **Starting / Running** | `⠋` / `⠏` | `运行中` | 亮蓝 / 青色 (`#38BDF8`) | `accent` (bold) | 高可见度单宽盲文动态指示 |
| **Blocked (ASK)** | `?` | `提问待答 ASK` | 琥珀黄 (`#F59E0B`) | `warning` (bold) | 醒目标注需要 human 决策 |
| **Just Completed** | `+` | `产出就绪 (余Ns)` | 翠绿 (`#22C55E`) | `success` | 30s 留存倒计时，明确产出可用 |
| **Timeout / No Result**| `!` | `超时中断` / `无产出` | 橙红 (`#F97316`) | `error` (bold) | 明确告警，不自动隐退 |
| **Failed** | `x` | `异常退出 (code 1)` | 亮红 (`#EF4444`) | `error` (bold) | 致命退出码标注 |
| **Closed / Evicted** | `.` | `已归档` | 灰度 (`#64748B`) | `muted` | 退出挂件，留存 `/herd` |
| **表头分界线** | `─` | `子任务 pi-herd` | 灰蓝 (`#334155`) | `muted` | 柔和单线分割，无多余边框 |

---

## 4. 生命周期状态机与数据架构 (Lifecycle & State Architecture)

### 4.1 任务生命周期流转图 (State Transitions)

```text
       [herd_spawn]
            │
            ▼
      [ starting ]
            │
            ▼
       [ running ] ◄─────────────────┐
       /    │    \                    │ herd_reply
      /     │     ▼                   │
     /      │   [ blocked ] (ask.json) ┘
    /       │
   ▼        ▼
[ done ]  [ failed / timeout / no_result ]
 (result.md)   (保持常驻挂件，直至人工 herd_close)
   │
   ├─► 挂件内展示 [产出就绪 (余30s)]
   │     │ (30s 倒计时衰减)
   │     ▼
   └─► 自动退出活跃挂件 (Evicted from widget)
         │
         ▼
       [ 磁盘 meta.json / result.md 永久保留 ]
       [ /herd 命令全量可查 ]
```

### 4.2 30 秒暂留衰减与自动卸载算法

挂件渲染器在每次 `refreshFleet()` 触发时执行以下过滤逻辑：

```typescript
const NOW = Date.now();
const MAX_DONE_LINGER_MS = 30_000; // 30 秒

// 过滤规则：
// 1. running, starting, blocked, failed, timeout, no_result 永久保留在活跃队列中
// 2. done 状态：若 (NOW - meta.endedAt) <= 30_000，予以保留并计算剩余秒数；超出 30s 则过滤剔除
// 3. closed 状态：直接过滤剔除
const activeRows = allAgents.filter(agent => {
  if (agent.state === "closed") return false;
  if (agent.state === "done") {
    const elapsed = NOW - (agent.endedAt ?? NOW);
    return elapsed <= MAX_DONE_LINGER_MS;
  }
  return true;
});

// 若活跃队列为空，直接卸载挂件，释放全部垂直空间
if (activeRows.length === 0) {
  unmountWidget(ctx);
  return;
}
```

### 4.3 会话重载冷启动无污染保障 (Cold-Boot Idempotency)

- 在扩展初始化或会话重新连入时，`refreshFleet()` 初次扫描磁盘。
- 历史会话遗留的 `done` 状态任务其 `endedAt` 均早于 30 秒前，因此在初次渲染时即被全部剔除。
- **结果**：冷启动时不会出现原版 6 个老旧完成任务突然霸屏的现象。

---

## 5. 独立离线交互原型验证指南 (Prototype Verification Guide)

独立离线交互原型文件位于：`/root/pi-herd/design/prototype.html`。

### 5.1 原型特点与实现声明
1. **完全自包含、离线可用**：
   - 零外部 CDN、零外部字体文件、零任何第三方 JavaScript 库。
   - 所有 CSS（Dark OLED 调色、单宽 Monospace 布局）与交互脚本均内联在单文件中。
2. **原型控制区与终端界面的严格区隔**：
   - 原型顶部设立独立的 `[PROTOTYPE CONTROLS · 交互演示控制台]` 边框面板，明确标注此面板仅供原型测试，非终端真实按键。
   - 内部为逼真的终端模拟器，包含转录流、`aboveEditor` 挂件、Pi 输入编辑器和底部状态行。

### 5.2 交互功能与测试场景
- **场景 1（混杂状态）**：点击 `[1. 混杂状态]`，查看运行中与待决策任务优先置顶、刚完成项带倒计时衰减。
- **场景 2（告警/异常）**：点击 `[2. 告警/异常]`，查看超时中断、异常退出等具体错误标签，验证其不会被自动清除。
- **场景 3（全量刚完成）**：点击 `[3. 全量刚完成]`，模拟原版 6 个任务刚完成的瞬间，观察最大 5 行展示配额与超出聚合行。
- **场景 4（30秒后/空闲态）**：点击 `[4. 30秒后/空闲态]`，查看活跃队列为空时挂件完全 unmount 卸载、终端高度开销归零的表现。
- **场景 5（历史总览）**：点击 `[5. 历史总览]`，模拟终端输入 `/herd` 展开全量任务历史审计抽屉。
- **宽度切换**：点击 `[切换为窄屏 (40 列 Narrow)]`，验证 40 列窄屏下的字符截断与自适应对齐。
- **时间步进（+10s 衰减）**：点击 `[步进时间 (+10s 衰减)]`，手动触发倒计时递减，观察任务在 30 秒到达时逐个退出活动条直至挂件自动隐藏。
- **模拟会话重载**：点击 `[模拟会话重载 (Reload)]`，验证旧的已完成任务在重载后不会死灰复燃。
- **键盘操作支持**：支持快捷键 `1`-`5` 切换场景，`W` 切换宽度，`R` 模拟重载，`H` 打开历史，`Esc` 关闭抽屉。

---

## 6. 后续对 `index.ts` 的低侵入改造方案建议 (Implementation Roadmap)

虽然本次任务严格限制为设计任务（禁止修改生产代码与配置），但为便于后续工程落地，特提供针对 `/root/pi-herd/index.ts` 的低风险重构路径：

1. **重写 `FleetView.render(width)`**：
   - 移除 `\u256d`、`\u2502`、`\u2570` 包围框绘制。
   - 改为输出首行单分界线（`\u2500`），中间穿插 `herd` 与中文状态摘要。
   - 数据行直接采用缩进单宽文本排版，去除两端竖线。
2. **优化 `refreshFleet()` 过滤机制**：
   - 引入 `MAX_DONE_LINGER_MS = 30_000` 判定。
   - 活跃队列长度为 0 时立即调用 `unmountWidget(ctx)`。
   - 将 `maxRows` 默认上限调整为 `5`。
3. **扩充状态文本描述**：
   - 根据 `meta.state` 与 `askPending` 生成 `产出就绪`、`提问待答`、`运行中`、`超时中断` 等语义化文本。

---

## 7. 静态语法验证与测试局限性说明 (Validation & Limitations)

### 7.1 本地静态校验记录
在当前开发环境中，通过 Node.js 进行了以下静态语法与结构检查：
1. **JavaScript 语法检查**：
   - 提取 `prototype.html` 中内嵌的 JavaScript 脚本块，通过 `new Function(...)` 进行语法解析，**检查通过（PASSED）**。
2. **HTML 标签配对与完整性检查**：
   - 检查 `html`、`head`、`body`、`style`、`script`、`main`、`aside`、`section`、`footer`、`table` 等标签配对，**开闭标签完全平衡（PASSED）**。
3. **外部资源引用检查**：
   - 扫描 `prototype.html` 中的 `http://` 与 `https://` 外部资源引用，**检测结果为 0 处外部引用（NULL）**，完全符合纯单机离线运行约束。

### 7.2 测试局限性声明 (Limitations)
- **非浏览器环境**：当前环境为纯命令行环境，未运行无头浏览器（如 Puppeteer/Playwright）进行真实像素级快照比对；所有交互和视觉均基于 DOM 标准与静态测试。
- **设计专属任务**：未对 `/root/pi-herd/index.ts`、`package.json` 及任何运行期配置进行编辑，确保线上系统零风险。
