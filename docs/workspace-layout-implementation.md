# Web 工作台布局实现记录

对应 [布局计划](workspace-layout-plan.md)，2026-11-03。仅修改 herdr-bridge 前端与文档；未修改原生 App、Go 服务、HTTP 契约、数据库结构或本地配置。原生参考提交仍为 `0ee21351748c334354011f9b3caa4946039a43ba`。

## 已实现

- 工作台从 `main.tsx` 抽出到 `web-ui/src/workspace/`。左右栏可收起，三栏宽度、Spaces/Agents 高度、终端分屏可拖动；窄窗口通过工具栏切换侧栏，优先展示终端。
- 原生文档只读导入 Space/Tab/row/column/stack/terminal 关系。相同 cwd 的显式空间不合并；机器限定 ID；空文档、解码错误、远端不可用均有恢复或提示。按快照 → 文档顺序初始化，在 doc/missed/created/机器事件及重连后更新，dirty 读取重新获取，丢弃已离开连接的结果。
- 网页私有空间支持新增、重命名、加入已有终端、新建 Shell、合并分屏与拆回标签；原生空间不提供写回或重排。切换空间恢复其标签和 pane 焦点，隐藏终端解除附着，不结束程序。
- Agents 使用真实 status 对象和 parent 关系，支持 Pinned / Needs you / Done / Working / Idle、按空间分组、折叠、子树提升及只读子 Agent 预览。普通 Shell 不当 Agent。置顶与已读通过 terminal labels 同步；Done 点击保持、前台可见性、每 turn 每观看周期一次写入均由前端处理。状态在逐事件接收时归约，避免 React 合并渲染吞掉忙碌→完成变化。
- Files/Git 跟随实际聚焦 pane 或子 Agent 的机器与 cwd，复用认证 core 隧道。文件目录使用固定脚本和 argv/env 路径参数；Unix NUL 分隔，Windows PowerShell LiteralPath。支持惰性树、只读预览、复制、刷新、界限及异常提示。
- Changes 显示 XY 状态、可获得的 numstat 和带行号 diff；区分非仓库、干净仓库、无 HEAD、二进制和命令失败。Git 读取禁用 optional locks/fsmonitor/外部 diff/textconv，无 Git 写入功能。
- 文件/Git 共用每连接 4 个并发预算，exec 超时 10 秒，文件页签前台 10 秒刷新，Spaces Git 元数据前台 30 秒刷新，并在目录/程序/Agent 状态变化时更新。面板切换保留同上下文选择；切换机器/目录、断线和卸载丢弃过期响应。
- 布局保存使用现有 version CAS，新增 `schemaVersion: 2`，仅持久化网页空间和视图引用；V1 迁移保留地址、只读、焦点及分屏尺寸。原生结构、pin/seen 标签不作为网页事实副本保存。
- 修复 `TerminalStore` 的 turn 事件处理：仅更新 turn，不把 Agent 的 `done/idle` 写入终端生命周期 state。只读终端继续保持远端权威网格，空间不足时可滚动，不发送输入/RESIZE/FOCUS。

## 当前差异和降级

- 原生 Mod/浮动等非标准终端布局节点没有对应 Web 渲染器，会提示部分节点无法显示；普通 row/column/stack 与可识别终端继续可用。网页不修改原生文档。
- 大于 JS 安全整数的数值形式 turn 不参与已读写入，避免向 core 写入错误计数；精确十进制字符串可按 u64 处理。浏览器 JSON 解码不能无损保留任意数值形式 u64。
- 新文件尚无 Git numstat 时显示“未统计”；打开后提供新增行预览。二进制统计单独标示，不伪造增删数量。
- 只读终端保持原端网格而不是改写其尺寸；拖动侧栏后通过滚动查看超出区域。可写终端使用现有 ResizeObserver/fit。
- 目录数量上限为每目录 500、总计 5000、深度 40；预览最多 1500 行/约 400000 字符；diff 最多 1500 行、每行 4000 字符。不是文件编辑器，也不提供提交、暂存或删除操作。

## 验证

使用现有 Node 24.15.0（当前 shell 默认 PATH 没有 npm）。

- `npm --prefix web-ui run typecheck`：通过。
- `npm --prefix web-ui test`：7 个测试文件、46 项测试通过；包含原有协议/终端回归及新增模型、服务、组件、文档竞态测试。
- `npm --prefix web-ui run build`：最终变更后通过（含 tsc -b）。
- 扩展 `tests/workspace.spec.ts`，保留终端生命周期测试，新增原生空间、Pin/Unpin、目录切换、文件/diff 预览、1280/1920/窄屏断言与截图输出。
- `PLAYWRIGHT_CHANNEL=chrome npm --prefix web-ui run test:e2e`：浏览器在启动阶段失败，Chrome crashpad 报 `setsockopt: Operation not permitted` / SIGTRAP，未进入页面测试。未生成可验收截图；不能把组件测试当浏览器验收。
- 本轮未接入真实 PostgreSQL/core/App 会话，因此远端 Windows、真实机器/仓库、原生 App 标签联动及视觉尺寸仍需实际环境验证。未运行 Go 测试，因为没有更改 Go 代码或共享协议。

## 后续优化：图标、Markdown 与移动端

2026-11-03：按反馈完成以下调整。

- Spaces 使用原生 App 风格的绿色首字母方块，worktree 使用分支图标；Agent 左侧改为程序身份图标，右侧单独显示状态。复用 App 的 Codex、Claude 等 SVG 与程序别名，Working 使用 900ms 旋转指示器，尊重 reduced-motion；未知程序回退通用 Agent 图标，不推断 Agent 工作状态。
- Files 的 `.md` / `.markdown` / `.mdown` 默认显示 Markdown 预览，可切换带行号的源码。支持标题、强调、列表/任务列表、表格、引用、代码块和链接；相对文件链接仍经当前机器的文件读取上下文打开。轮询刷新保留显示模式。HTML 以文本显示，图片显示占位描述，不自动加载外部资源。
- Markdown 使用 Marked 16.4.2 lexer，输出为 React 元素，不插入生成的 HTML。由于安装时网络连接受限，依赖以本地发行包 `web-ui/vendor/marked-16.4.2.tgz` 固定，许可证随包保留；其余依赖锁定记录不变。
- 小于 1000px 的工作台默认仅展示终端。左上角菜单在覆盖式弹层中选择 Spaces / Agents，右侧按钮打开 Files / Changes；选择空间或 Agent 后返回终端，关闭按钮与 Escape 可退出面板。面板打开时保持终端实例，暂停被遮挡终端的自动已读写入。
- 手机端每次显示一个聚焦 pane，通过“切换分屏终端”选择其他 pane；桌面端仍保留原分屏布局。结合 VisualViewport、动态视口高度及安全区域处理软键盘和旋转后的可用空间。移动端工具操作移入菜单，终端区不再被左右侧栏压缩。
- 验证：typecheck、53 项单元/组件测试、生产构建及 diff whitespace 检查通过。扩展了手机端 Playwright 用例；4 个浏览器用例均停在 Chrome 启动阶段（`setsockopt: Operation not permitted`），未完成真实浏览器或移动设备截图验收。
