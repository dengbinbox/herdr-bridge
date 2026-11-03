# 实现与验证记录

日期：2026-11-03。源码及本次生成的依赖缓存、构建产物、测试临时目录均位于 `herdr-bridge/`。未修改 herdr-core 或 herdr-app，未操作开发者已有 core 会话。

## 已执行并通过

| 检查 | 结果与范围 |
|---|---|
| 前端 strict TypeScript | `npm --prefix web-ui run typecheck` 通过 |
| 前端生产构建 | `npm --prefix web-ui run build` 通过，产物在 `web-ui/dist/`，`/ui/` 基路径；终端代码独立分块 |
| Vitest / Testing Library | 18 项通过：Go/TS 共享封装向量、core 帧拆分合并/非法长度、UTF-8 JSON 行事件、并发 RPC、快照时序、CREDIT、请求上限、断线/超时不重放、xterm 输出/resize 顺序、只读与销毁、布局校验 |
| npm 锁文件一致性 | `npm ci --dry-run --offline --ignore-scripts` 通过；这是 dry-run，不是一次全新联网安装 |
| Go 协议 | `go test -race ./internal/protocol` 通过，包括控制 schema 字段一致性、共享向量、畸形封装和 fuzz seed |
| Go stdin 队列 | 对 `inbox.go` 与对应测试运行 `go test -race` 通过；覆盖 in-flight 字节预算、复制所有权和并发计数 |
| Go 配置/密码 | 对 server 的 config/crypto 源文件与测试运行 `go test -race` 通过；严格 YAML、多文档拒绝、安全 Cookie 开发边界、Argon2id 盐与错误密码 |
| Go 代理身份/配置 | 对 client 的 config/identity/Unix lock/security 源文件与测试运行 `go test -race` 通过；目标环境隔离、文件权限、稳定 UUID、重复实例锁、损坏状态拒绝 |
| Windows 局部交叉编译 | 代理配置、身份、Windows LockFileEx 与 ACL 代码以及对应测试通过 `GOOS=windows GOARCH=amd64 go test -c`；没有执行 Windows 二进制 |
| 全部 Go 源码的类型检查 | 使用 `.cache/` 内一次性 WebSocket **接口桩**和独立 `-modfile` 执行 `go test -run '^$' ./...` 通过。接口桩的 I/O 方法均 panic，未模拟真实 WebSocket 行为，生产 go.mod 未添加 replace |
| HTTP 路由/契约与发送调度 | 在上述接口桩环境，实际运行静态页面/API 隔离、Origin/可信代理、OpenAPI 路由/会话字段、控制优先/公平调度、慢隧道隔离、输出先于关闭测试并通过。这些测试不调用接口桩的 I/O 方法 |

前端在本机现有包的离线副本上检查；版本已固定，package-lock 中恢复了对应发行包校验摘要。初始 HTTP 类型从 OpenAPI 契约导出；固定版本 `openapi-typescript@7.6.1` 的再生成命令和 CI 步骤已配置，但本环境未运行该下载工具。

## 仍未完成的验收

1. **真实 Go 依赖构建 / 全套 `go test -race ./...`**：本机没有 `github.com/coder/websocket@v1.8.14` 源码 zip，网络/DNS 调用受限。已尝试真实构建，停在依赖解析；接口桩检查不算生产构建或 WebSocket 集成通过。
2. **PostgreSQL 集成**：未提供可连接的隔离测试数据库，Docker socket 也不可访问。已加入迁移、唯一约束/回滚、池超时、多用户隔离、离线身份不可重新认领、并发重复注册、Key 到期/撤销、双浏览器转发、代理/隧道配额和用户禁用测试；尚未执行。
3. **真实 core**：已用独立 HC_SESSION、socket 和 XDG 目录尝试运行 native core 生命周期测试，`hc connect` 在握手读取时返回 EOF，测试未通过；临时目录已清理。不能据此宣称真实 shell 的创建/恢复、输入和 resize 已验收。
4. **浏览器 Playwright**：两个测试用例在启动 Chrome 时被环境阻止，报 `setsockopt: Operation not permitted` 后退出。测试体未执行，不能计为浏览器通过。用例覆盖登录、附着、文本输入、尺寸改变、只读、分离与显式结束确认。
5. **平台与终端行为**：真实中文输入法组合输入、粘贴、鼠标协议、Vim/top 等全屏 TUI、大输出/网络抖动、Windows ConPTY/win32-input-mode 需要真实浏览器和 core 继续验证。

## 可复现的后续检查

在可获取固定依赖的环境运行根目录 README 中的构建与测试命令。PostgreSQL 测试要求数据库名以 `herdr_bridge_test` 开头，每项测试在独立 schema 中运行并清理；不以 SQLite 替代。

同时设置 `HERDR_BRIDGE_TEST_HC`（固定 core 版本的绝对路径）和 `HERDR_BRIDGE_TEST_DATABASE_URL` 后，`TestIntegrationRealAgentAndCore` 将构建真实代理，通过浏览器 WebSocket、server、出站代理和隔离 core 创建 shell、读取输出、修改尺寸、断开再查验存活，最后显式结束。它只在本目录创建临时状态，使用 Unix `/bin/sh`，不接触默认 core。

CI 已包含真实依赖下载、PostgreSQL 服务、Go race/构建、Windows 代理交叉编译、OpenAPI 类型再生成、npm ci、前端检查和 Chromium 测试；本次没有执行远端 CI。需要原生 core 的测试必须另外提供上述固定可执行文件，不自动下载 latest。

## 当前实现约定

- `max_bridges_per_user` 统计在线代理；永久归属记录不会随离线删除。`max_tunnels_per_bridge` 包含正在打开的隧道。
- 代理终身连接内保留最多 100,000 个关闭隧道的幂等记录，达到上限拒绝新打开；重连产生新的 connection ID 和记录空间。
- 数据队列限额针对排队字节；共享 writer 另可有一条正在发送的消息，单次写入超时 10 秒。控制队列最多 128 条，每隧道数据队列最多 1024 条，代理 stdin 队列最多 128 条。
- 代理 stderr 与 core stdout 完全分离，只保留封顶字节计数用于脱敏调试，不记录其原始内容。
- 布局显式保存、水平基础分屏、最多 8 个标签；不写原生 app 的布局文件。更完整拖拽布局、跨账号共享、运维安装与多 server 路由不在首版范围。
