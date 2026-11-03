# Web 工作台对齐 herdr-app：实施计划与交接说明

状态：**待执行；本次仅编写计划，没有实现本轮 UI 改动。**

用户目标：当前机器的工作台布局参考 herdr-app。左侧展示 Spaces 和 Agents；中间保留终端与标签/分屏；右侧提供 Files、Changes 查看面板。Spaces 与 Agents 的展示逻辑应接近原生 App，尤其是 Pinned、Working、Idle 等分组，不是将现有终端列表简单换标题。

本计划对应 `/ui/bridges/:id` 工作台。账号、Key、管理页面及机器选择页不作为本轮重构对象。

## 1. 执行范围与约束

- 只修改 `herdr-bridge/` 内文件。`../herdr-app`、`../herdr-core` 仅作为只读参考，不修改它们。
- 复用现有 React、strict TypeScript、Radix、TanStack Query、react-resizable-panels、xterm.js；不为此次布局改造另换前端框架。
- 使用当前认证后的 core 隧道取得终端、空间、文件和 Git 数据。文件来自**所选代理对应的机器/远端机器**，不能误读中央 server 的文件系统。
- 不创建新的无认证文件/命令执行 API，不把 Files/Changes 做成服务器本机的文件浏览器。
- 原生 `herdr-app` 布局文档只读。网页新增空间、标签、分屏及视图状态仍存中央数据库的用户私有布局，不调用 `doc.set` 覆盖原生布局。
- Pin/Unpin 和已读同步使用 App 已定义的 terminal labels；这是终端元数据同步，与原生布局文档写入不同。
- Files/Changes 本轮仅提供查看，不增加上传、编辑、Git add/commit/reset、删除、SSH 机器管理等操作。
- 保留登录隔离、Origin 检查、只读附着、CREDIT、断线重连、操作不重放和显式结束终端的既有语义。
- 不改本地 `config.yaml`、`.vscode/launch.json`、用户目录内的凭据或正在运行的默认 core 会话。不要自动提交/推送此次实现；需要提交时遵循用户后续指令。

## 2. 已核对的参考依据

阅读时核对到的 herdr-app 提交：`0ee21351748c334354011f9b3caa4946039a43ba`。执行前检查工作区现状；若原生实现更新，核对差异后再适配。

| 参考文件 | 用途 |
| --- | --- |
| [默认布局](../../herdr-app/defaults/layouts/main.json) | 左侧 Spaces/Agents、中间标签与终端、右侧 Files/Changes 的实际结构 |
| [Spaces mod](../../herdr-app/defaults/mods/spaces/main.js) | 机器分组、目录/仓库命名、worktree 分层、分支信息和刷新策略 |
| [Agents mod](../../herdr-app/defaults/mods/agents/main.js) | 完整分组、排序、置顶、子树、Done 停留、标题和交互 |
| [model.rs](../../herdr-app/src/model.rs) | Space/Tab/Agent 模型、状态推导、优先级、名称回退 |
| [window.rs](../../herdr-app/src/window.rs) | `publish`、`reconcile`、`tend_terminals`、`share_seen`；实际 Agents 候选与标签处理 |
| [mirror.rs](../../herdr-app/src/mirror.rs) | 共享空间文档、Tab/root 节点、机器限定 ID |
| [mirror_sync.rs](../../herdr-app/src/mirror_sync.rs) | `doc.get {name:"herdr-app", on}` 的真实读取路径与异常状态 |
| [标签规范](../../herdr-app/docs/labels.md) | `herdr.pinned`、`herdr.seen`、`turn` 的共享语义 |
| [Files mod](../../herdr-app/defaults/mods/files/main.js) | 焦点目录、惰性展开、平台差异、预览与数量限制 |
| [Changes mod](../../herdr-app/defaults/mods/changes/main.js) | Git 读取参数、未提交文件、无 HEAD、新文件、diff 展示 |
| [core OpenRPC](../contracts/core/hc.openrpc.json) | 已固定的 RPC 参数、返回类型和能力边界 |
| [core 流协议](../contracts/core/stream.md) | 快照、事件、远端地址、doc/missed、流控 |

**适配陷阱：**App 的 `agents()`、`panes()`、`spaces()`、`focused()` 是原生运行时提供给 Mods 的适配结果，不是浏览器可直接调用的 core RPC。App 部分代码读取的 `status` 已被规范化成字符串，而固定 core schema 的 terminal `status` 是包含 `state` 等字段的对象。必须编写适配层，不能直接照抄字段读取。

## 3. 目标布局与交互

```text
┌──────────────────────┬────────────────────────────────┬───────────────────────┐
│ 机器名称 / 连接状态    │ 当前 Space / 标签页 / 新建      │ Files | Changes | 收起 │
├──────────────────────┼────────────────────────────────┼───────────────────────┤
│ Spaces               │                                │ 当前机器和工作目录     │
│  本机 / 远端分组      │ 当前标签的终端 / 分屏           │                       │
│  项目 / worktree     │                                │ 文件树 / 文件预览      │
│  当前选中空间         │                                │ 或变更列表 / diff      │
├──────────────────────┤                                │                       │
│ Agents               │                                │                       │
│  Pinned              │                                │                       │
│  Needs you           │                                │                       │
│  Done                │                                │                       │
│  Working             │                                │                       │
│  Idle                │                                │                       │
├──────────────────────┴────────────────────────────────┴───────────────────────┤
│ 当前终端 / 工作目录 / 连接状态 / 只读或共享输入提示                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

- 默认左栏约 268px，右栏约 368px，参考 App 数值；中间区域优先占据剩余空间。
- 左栏 Spaces、Agents 上下排列，分别滚动，可调整二者高度；侧栏和右栏可收起及恢复。
- 右侧 Files 与 Changes 为同一个侧面板的两个页签，默认可见 Files；切换页签保留当前上下文内的展开和选中状态。
- 右栏展开/收起、拖动分隔条和窗口大小变化后，终端应重新 fit；只读观察终端不因此向 core 发 RESIZE。
- 当前 Space、Tab、Pane/focus、右栏当前目录之间必须有明确映射。分屏时以实际聚焦 pane 为准，不一律取第一个终端。
- 点击子 Agent 预览时，右栏跟随实际显示的子 Agent，而不是仍沿用父终端目录。
- 小窗口优先保留终端；侧栏允许折叠/切换显示，页面不出现无法操作的整体横向溢出。
- 使用清晰的紧凑行、层级和状态图标，不把原始 JSON 状态直接呈现给用户；键盘焦点、按钮名称、折叠状态需可访问。

## 4. 数据模型与启动同步

### 4.1 建议拆分

从目前 `web-ui/src/main.tsx` 中抽出工作台，建议建立以下文件或同等职责的模块：

```text
web-ui/src/workspace/
  Workspace.tsx                # 布局与协调
  model.ts                     # Space/Tab/Pane/AgentView、命名与定位
  native-layout.ts             # herdr-app 文档到 Web 模型的只读适配
  agent-state.ts               # 状态、已读、held Done、子树优先级、排序
  useWorkspace.ts              # 连接、快照/事件、文档读取、局部视图
  SpacesPanel.tsx
  AgentsPanel.tsx
  InspectorPanel.tsx           # Files/Changes 与目录上下文
  FilesPanel.tsx
  ChangesPanel.tsx
  file-service.ts              # file.read / 受限目录列举
  git-service.ts               # Git 元数据、status/numstat/diff
  workspace.module.css
```

文件数量可调整，业务推导应能独立测试，不能将所有逻辑继续塞入 JSX 或扩大成新的 Go 通用框架。

### 4.2 初始化顺序

1. 建立当前 bridge 的 core 隧道并完成 `hello`；保存 `methods/features`，按能力启用相关面板。
2. **先订阅 events 并接收 snapshot，再读取文档。**不要在快照前用空列表覆盖已有展示/保存状态。
3. 读取 `machine.list`，读取本机 `doc.get {name:"herdr-app"}`；对可用远端通过 `on` 读取对应布局。
4. 导入原生 Space → Tab → Pane/terminal 关系，再合并网页私有空间和恢复视图。
5. 对 doc 事件、`missed`、重连及远端重新可用重新读取相关布局；不能只在首次加载读取一次。
6. 文档读取应防止竞态：请求发出后若出现更新事件，标记 dirty，并在完成后再取最新值，避免旧响应盖过新状态。
7. 所有异步结果携带 bridge/connection/context generation。切换代理、目录、space 或断线后丢弃过期结果。

### 4.3 所有 ID 的作用域

- 全局键必须区分 `bridge_id`、远端机器和本地 ID。同名 `t1`、space/tab/pane ID 在不同机器上不能合并。
- 原生远端文档中的本地 ID/终端地址按 `mirror::qualify` 的语义限定机器；只限定一次。
- `terminal.attach`、`terminal.label` 等终端 RPC 传 core 视角的完整地址；`machine.exec`、`file.read` 用 `on` 指定机器，不能混用两种寻址方式。
- 区分空间来源：`core`（导入）、`web`（网页私有）、`recovered`（恢复/未分组）。不得把同 cwd 的两个显式空间自动合并。

### 4.4 空文档和不可用状态

- `doc.get` 返回 null 是没有原生空间，不是加载失败。页面依然允许使用网页私有空间、普通终端。
- 有 `herdr.space` / `herdr.tab` 标签但文档尚未到达的终端，按原生 reconcile 思路等待/恢复归属，不因瞬时缺失丢弃。
- 未归属任何空间的终端放在明确标识的“未分组”恢复区域；不伪称其是 App 已有空间，也不在读取时自动写标签/原生文档。
- 不可解码文档/未知原生节点应提示并尽可能保留可识别的终端；不得清空持久布局、覆盖原生文档或静默丢掉空间。
- 远端不可用时保留空间位置并标离线/不可用；不能将其临时从布局中永久删除。

## 5. Spaces 的展示规则

1. 原生空间优先使用显式名称；未命名时参考 `Model::space_name`：首个终端当前 checkout/工作目录的目录名，最后回退 `space.folder`。
2. 标签名优先使用显式名称，未命名按空间内顺序显示 1、2、3；Tab 不能继续等同于一个全局终端地址。
3. 多机器时按机器分组；本机在前，同一机器内保留原始空间顺序。展示稳定项目标识和当前选择。
4. Git worktree 按共同仓库归组/缩进，不能只比较文件夹 basename。仓库分组键必须包含机器。
5. 分支、ahead/behind 信息按原生 Spaces mod 的逻辑补充；目录变化、程序/Agent 从忙碌转空闲、远端恢复时刷新，有后台节流和手动刷新。
6. 默认 App 的 Spaces 侧重项目、目录、分支；Agent 状态主要放在 Agents 列表，避免把所有状态徽标再堆一遍到 Spaces。
7. 点击 Space 切换它当前选中的 Tab；切回时恢复先前 Tab、焦点和分屏，不将所有空间的标签平铺混在一起。
8. 保留新建 Shell、打开终端、分离和显式结束能力；新建 Shell 使用选中空间的目录及机器。
9. 可提供网页私有 Space 的新增/重命名。导入原生 Space 本轮只读，不添加会修改原生布局的删除/重排功能。

网页空间/标签归属以自己的持久模型为准；不要把网页私有 ID 写成原生 `herdr.space/herdr.tab` 导致 App 自动误接管。不应仅为了打开已有终端而重新运行程序。

## 6. Agents：必须对齐的业务规则

### 6.1 候选 Agent 与状态适配

- 参考 App `window.rs::publish`：顶层 Agents 来自空间/标签中的终端 pane，且具有可推导的 Agent 状态。普通 Shell 不应因为“进程仍活着”就进入 Working。
- 原始 status 缺失不是 Idle Agent；不靠进程名称或窗口标题臆测状态。曾上报/临时清除、终端结束等边界与原生 `set_word/status` 对齐。
- core 的原始 `terminal.status.state`、`turn`、`labels` 需先适配，App 的规范化 `status` 字符串不能直接照抄。
- `records` 中的 OSC 状态记录不等于独立终端子 Agent；子 Agent 树以 terminal `parent` 关系为依据。

### 6.2 分组和排序（已核对原生源码）

默认 **Priority** 模式：

| 顺序 | 分组 | 规则 |
| --- | --- | --- |
| 1 | Pinned | `herdr.pinned` 存在且非空；独立置顶，仍显示其当前状态 |
| 2 | Needs you | blocked/error，或活跃子 Agent 的更高优先级将父行提升到此组 |
| 3 | Done | 需要用户注意的未读完成状态，含后述 held Done 行为 |
| 4 | Working | Agent 正在工作 |
| 5 | Idle | 已读完成/空闲 |

- 固定优先级 `blocked:4 > done:3 > working:2 > idle:1`。
- 原生先按有效优先级降序，再按最近状态变化时间降序、状态序号降序排序，然后拆出 pinned 列表。
- Pinned 内仍沿用对应排序；同一个顶层 Agent 从普通组移除，**不能在 Pinned 与 Working/Idle 等组重复出现**。
- 无成员的分组不占位；分组可折叠，显示数量。数量按父行成员计算，不把所有展开的子行再重复计入。
- 提供原生已有的 **Grouped by space** 模式：Pinned 仍在最前，其余按 Space/Tab/Pane 顺序归组，不再另外生成 Working/Idle 小节。
- 折叠与排序偏好可持久化。无需迁移原生 Mod 私有 localStorage 的旧版 pins 数据。

### 6.3 Pin/Unpin

```json
{"method":"terminal.label","params":{"terminal":"box/t7","labels":{"herdr.pinned":"1"}}}
{"method":"terminal.label","params":{"terminal":"box/t7","labels":{"herdr.pinned":""}}}
```

- 空字符串移除标签，不写 `false` 字符串（非空会被原生判定为 pinned）。
- 点击 Pin 按钮不能同时触发 Agent 跳转。
- 等待结果/事件确认；失败恢复之前状态并显示可理解的错误。断线时不自动重放该操作，重新取得实际标签。
- App 或另一网页修改标签后，当前网页通过事件同步显示。

### 6.4 Done、已读和焦点保持

根据 [labels.md](../../herdr-app/docs/labels.md) 和 `Model::status`：

- blocked/error → Needs you；working → Working。
- 其他已报告状态，有有效 `herdr.seen` 时：`turn > seen` → Done，否则 Idle。
- **缺少 seen 不等于 seen=0**，回退本地 seen 状态机：初始已见；working/blocked 后在未查看情况下结束才产生未读完成；依原生规则处理。
- 标签是十进制整数文本。严格解析，拒绝负数、NaN、部分数字文本；兼顾 core u64 超出 JS 安全整数范围的处理策略。
- 真正可见且浏览器页面在前台、窗口有焦点的 Agent 才视为“正在看”；隐藏页签、被另一终端覆盖的 pane 不能自动标已读。
- 更新 `herdr.seen` 只提高到当前 turn（缺失时初始化），每个持续可见周期每 turn 写一次。离开后再回来才重新考虑写入，避免反复覆盖其他客户端“标未读”。
- status 事件先于 turn 事件：完成/未读判断需处理这个顺序，不能仅收到 `done` 就永久错误归组。
- **held Done**：点击 Done 行后，虽已读状态变成 Idle，该行在当前焦点保持期间仍留在 Done 组，避免点击后从鼠标下消失；离开才回 Idle。若转 Working/Blocked，立即按新状态移动。
- 状态变化时间将 done/idle 视作同一底层空闲状态；仅因用户看过而从 Done 到 Idle，不应制造一个“刚刚发生”的 Agent 活动时间。

已读/置顶属于元数据；只读附着仍绝不发送键盘输入、RESIZE 或 FOCUS 控制帧。不要把“读取列表”误当“用户正在看终端”。

### 6.5 子 Agent 与父行提升

- 按 `parent` 构造活跃子树，深度优先展示，支持展开/折叠；限制深度/节点数并检测循环。
- 没有独立 pane 的子 Agent：error 归为 blocked，done 作为 idle；它向父级报告结果，不独立制造父级的 Done 通知。
- 父行用于归组的有效优先级取自身（含 held Done）及子树状态的最大值。自身 Idle、子级 Blocked 时，父行必须进入 Needs you。
- Pinned 父行仍留在 Pinned，但子树紧急状态应可见。
- 顶层候选与展开子树的关系依据原生实现处理；区分“有独立 pane 的子终端”和“仅供 peek 的子 Agent”，不要仅按 `parent != null` 全部删掉或全部平铺。
- 点击父行定位对应 Space/Tab/Pane；点击无独立 pane 的子 Agent 提供临时查看，关闭后回到原 pane，不破坏布局或结束程序。

### 6.6 行标题

参考原生 `lead/title/label/detail`：优先有意义的用户命名/Agent 标题，显示 `space · detail` 和必要的远端机器标识；不要在所有行展示无信息的自动标签数字。只有同空间同标题出现歧义时补充标签序号。状态使用图标与可访问文本，不只靠颜色区分。

## 7. Files 面板

### 7.1 上下文与调用

上下文包含 `bridgeId + connectionGeneration + machine + cwd`。优先取实际显示/聚焦终端的当前目录（有有效 foreground.cwd 时优先），再回退 terminal.cwd、space.folder。远端 `on` 必须从目标终端/空间所属机器取得。

当前 schema 没有 `file.list`，但已有：

- `file.read {path, cwd?, on?, offset?, limit?}` → `{text, first, last, lines}`。
- `machine.exec {argv, cwd?, on?, env?, timeout?}` → 包含 code、timed_out、truncated、stdout/stderr。
- **machine.exec 的 stdout/stderr 是 base64，file.read 的 text 是文本。**不能照抄 Mod 的 `exec` 包装层直接把 base64 当 stdout 使用。

目录列举复用 App 的方案：Unix 固定脚本通过 argv 传路径、NUL 分隔；Windows 使用 PowerShell 的 LiteralPath 和结构化输出。不得将用户目录直接拼接进 shell 源码。目标平台按目标机器判断，不能用浏览器平台推断远端 OS；无法探测/缺少所需工具时显示明确不可用原因。

### 7.2 必需行为

- 惰性展开目录、目录优先排序、隐藏 `.git`，保留其他点文件；不自动递归整棵仓库。
- 每目录最多 500 项，总计最多 5000 项，深度上限 40；超出提示，收起时释放子目录缓存。
- 文件名带空格、中文、引号、换行、制表符时仍能正确列举及读取；不要解析 `ls` 的人类可读输出。
- 点击文件进入只读预览，可返回目录树；显示文件名和目录位置，支持行号/复制文本。
- 控制请求和渲染体积；参考 App 文本预览最多约 400,000 字符，优先通过 file.read 的行限制减少传输。不可读、二进制/含 NUL、过大、文件已删除时显示明确状态。
- 目录/机器/终端切换后，旧请求结果不能覆盖新上下文。
- 提供刷新；仅面板可见且页面在前台时低频刷新（可参考 10 秒）。浏览器没有 App 的 watchFolder API，不假装已实现原生文件监视。

## 8. Changes 面板

### 8.1 读取策略

使用 `machine.exec`、argv 参数调用 Git，`cwd/on` 与 Files 一致。先解析实际仓库根目录，再读取状态：

```text
git rev-parse --show-toplevel
git --no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false \
    status --porcelain=v1 -z --no-renames --untracked-files=all
```

- 结构化解析 NUL 分隔状态，覆盖新增、修改、删除、未跟踪、冲突、原有重命名状态；`--no-renames` 关闭重命名检测时允许按新增/删除呈现，但不能错配路径。
- 显示文件路径、状态和增加/删除行数；文件列表最多 1000 项。
- 有 HEAD 时参考 App：`diff HEAD --numstat -z --no-renames` 和该文件的 `diff HEAD` 展示当前相对 HEAD 的未提交结果。
- 无 HEAD 时合并 index/worktree 读取结果；新增文件可用 file.read 生成新增行预览，不把空仓库误报成错误。
- 文件 diff 使用 `--no-ext-diff --no-textconv --no-color -- <path>`；路径以独立 argv 传入并由 `--` 隔离。数字统计读取也应禁用外部 diff/textconv。
- 无仓库与仓库干净分别显示“当前目录不是 Git 仓库”和“没有未提交修改”；Git 不存在、远端不可达、超时等错误不能伪装成干净状态。
- 本轮默认像 App 展示相对 HEAD 的合并工作区差异；暂存/未暂存状态可通过 XY 标识说明，不强制新增复杂编辑/暂存操作。

### 8.2 Diff 视图

- 点击文件显示带行号、hunk 分隔、增删色彩的差异，支持横向滚动。
- 区分 +++/--- 文件头、hunk、增加、删除、上下文和 no-newline 标记，不能把元信息误算成内容行。
- 二进制变更、无可显示文本差异、空文件、删除文件、冲突文件均有明确提示。
- 参考 App 限制最多 1500 行 diff、单行最多 4000 字符，截断处说明；多行视图使用虚拟化或等效有界渲染。
- 不加入 App 中的 Commit 输入框/按钮，本轮用户仅要求“可以查看”。

## 9. RPC、缓存与保存策略

- 保留 `CoreClient` 流式解码和 128 并发上限；Files/Git 额外设小并发预算（例如 4），避免挤占终端 RPC。
- `machine.exec` 设置显式较短 timeout（例如 10 秒），小于现有浏览器 RPC 超时；检查 code、timed_out、truncated，不能把部分输出无提示当完整结果。
- 初始 8 个终端限制不应阻止展示原生所有 Spaces/Tab 元数据。只为当前可见 pane/peek 建立 attach；隐藏、切换、收起后按现有语义 detach，不杀程序。
- 文件/目录/Git 查询可手动或按节流重新读取；terminal.run、输入、标签写入不在重连后自动重放。
- query/cache key 必须包含用户、bridge、机器和目录；退出登录清空，切换 bridge 卸载旧控制器。无界 Map 缓存须有淘汰策略。
- 网页布局继续使用 `/api/v1/layouts/{bridge_id}` 的 version CAS。HTTP 的 version 是并发控制版本，不是布局格式版本。
- 新布局 document 增加独立 `schemaVersion: 2`，保存网页私有空间/Tab/Pane、当前选择、分屏、左右栏尺寸、折叠项、Agents 排序和 Inspector 页签等视图状态。
- 导入原生结构作为运行时数据，只保存必要的视图引用，不把一次失败/离线读取变成“原生空间已删除”。Pinned/seen 的事实来源是 core labels，不另建一份相互冲突的网页真值。
- 兼容现有 `{tabs:[{id,observe}],split,active,sizes}` 文档：迁移为一个网页恢复空间，不丢终端地址和只读标记。旧数据可读，冲突不覆盖其他页面。
- 此次不需要数据库表迁移，现有 JSONB document 可以承载 V2。若确有必要新增 HTTP 契约，先说明原因并更新契约/类型/测试，不能顺手破坏现有路由。

## 10. 推荐实施阶段与交付物

### 阶段 A：建立可测试的模型与协议适配

- 阅读上述原生来源，补齐 TerminalRecord 类型及 capability 信息。
- 实现原生文档读取/限定 ID/节点解析，Space/Tab/Pane 关联，事件与连接 generation 控制。
- 实现 Agent 状态推导、标签写入、held Done、子树优先级及两种分组纯函数。
- 建立 V1 → V2 布局迁移与校验。

交付：模型模块与边界测试；暂无需一次做完全部视觉样式。

### 阶段 B：三栏工作台与左侧列表

- 抽出 Workspace，完成 Spaces/Agents 左栏、标签/终端中区、可收起右栏框架。
- 接入真实原生空间、网页恢复空间、Space/Tab 切换、pane 焦点、子 Agent peek。
- 实现 Pin/Unpin、分组折叠、Priority/Grouped by space、状态和标题。
- 保留只读、显式结束确认、断线恢复及布局 CAS。

交付：左侧按实际数据工作，不使用假 Space/假 Agent 长期占位。

### 阶段 C：Files/Changes 查看

- 实现受限目录读取、文件预览、Git 查询和 diff 解析。
- 正确处理本机/远端、目录切换、无 Git/无权限/超时/大输出、空仓库和二进制。
- 控制查询并发、轮询生命周期与缓存。

交付：右侧读取所选机器上的真实内容，仅查看。

### 阶段 D：集成、视觉及回归

- 补齐工作台测试，更新相关使用说明和布局版本说明。
- 执行构建、类型检查、单元/组件与浏览器测试；能联调时提供真实 core、原生 App 与网页一致性证据。
- 给出实际截图及验证结果；环境阻塞时明确标记，不把静态构建、模拟服务测试或接口桩算作真实后端联调。

## 11. 必须覆盖的验收用例

### Spaces / 隔离

- [ ] 原生两个 Space、多个标签/分屏能正确展示，点击后定位正确终端。
- [ ] 相同 cwd 的两个命名 Space 不被合并；同名 space/t1 在两个 bridge 或本机/远端不串数据。
- [ ] 无原生文档时仍可使用网页恢复/私有空间和普通 Shell。
- [ ] 原生 App 修改布局后网页刷新相关文档，网页不写回 `herdr-app` 文档。
- [ ] worktree 与普通项目按真实仓库关系展示；远端离线不会清除保存的空间。
- [ ] V1 布局迁移保留终端、只读、active、分屏信息；并发保存冲突仍返回/展示冲突。

### Agents

- [ ] 默认组顺序严格为 Pinned、Needs you、Done、Working、Idle；空组隐藏。
- [ ] Pin/Unpin 与 App 同步；Pinned 在其他组不重复；切换 Grouped by space 后仍置顶。
- [ ] 普通 Shell、status 缺失终端不伪装为 Agent。
- [ ] raw error 显示 Needs you；有 seen/missing seen、turn 递增、status→turn 顺序均正确。
- [ ] 点开 Done 后行保持原组，离开才归 Idle；再次 Working/Blocked 时立即迁移。
- [ ] 后台浏览器页签/不可见 pane 不自动已读；每次持续可见周期每 turn 只写一次。
- [ ] 其他客户端标未读不会被未发生新观看行为的网页无限回写覆盖。
- [ ] 父 Idle + 子 Blocked 时父归 Needs you；无独立 pane 子 Agent 的 Done 不当顶层 Done 通知。
- [ ] 子树折叠、循环/过深保护、子 Agent peek 与目录焦点同步正确。
- [ ] 多行同名、自动数字标签、远端标识和状态排序稳定，不因“已读”制造虚假活动时间。

### Files / Changes

- [ ] 聚焦终端、Space、子 Agent、机器切换时，右栏切到正确 cwd/on。
- [ ] 慢请求完成时不会污染已切换的上下文；断线/卸载停止轮询。
- [ ] 目录惰性加载；中文、空格、引号、换行、制表符路径可用；路径不会被当 shell 代码执行。
- [ ] file.read 文本和 machine.exec base64 各自正确解码；超时/截断不被忽略。
- [ ] 大目录、超长行、大文件、二进制、无权限和删除后预览均有界且显示真实状态。
- [ ] Git 无 HEAD、干净仓库、非仓库、staged/unstaged/untracked、删除、冲突、重命名拆分场景均正确。
- [ ] Git 查询不触发外部 diff/textconv，页面不执行 add/commit/reset 等写操作。

### 终端回归与实际验证

- [ ] 拖动侧栏/分屏和窗口缩放后 xterm 尺寸正常；只读模式没有输入/RESIZE/FOCUS 写入。
- [ ] 终端输出仍直写 xterm，写入完成后 CREDIT；不放入 React 状态。
- [ ] 分离/切换/关闭网页只断开查看，只有确认结束才 terminal.kill。
- [ ] 重连重新订阅/读取文档/附着；副作用操作不重放。
- [ ] 1280×800、1920×1080 和窄窗口布局可用；长列表滚动和键盘导航可操作。
- [ ] `npm --prefix web-ui run typecheck`、`npm --prefix web-ui test`、`npm --prefix web-ui run build` 通过。
- [ ] 扩展 Playwright 用例覆盖分组、空间定位、目录切换和文件/diff 预览；保留现有终端生命周期用例。
- [ ] 如更改 Go 业务代码或共享协议，运行相应 Go/race/契约测试并解释改动必要性。

## 12. 给执行 agent 的最终交接要求

实现报告应说明实际改动文件、与原生 App 对齐的规则、明确的差异/降级行为、测试命令与结果，以及未能验证的环境条件。优先复用现有接口和业务边界，完成一个真实可用的工作台；不要仅交付三栏静态外观，也不要将本轮扩大为文件编辑器、Git 客户端或原生布局双向同步项目。
