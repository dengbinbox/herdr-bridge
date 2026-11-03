# Herdr Bridge

Go 中央服务 + 主动出站代理 + React 网页终端。代理通过 `hc connect` 接入现有 herdr-core；无需修改 core，也无需给代理机器开放入站端口。

已实现账号/会话、用户 Key、代理归属与在线注册、独立浏览器隧道、终端协议、标签/分屏/只读观察、布局版本控制和管理页面。**当前代码尚未完成真实 PostgreSQL/core 全链路与浏览器验收**；已执行的检查和环境阻塞详见 [验证记录](docs/validation.md)。

## 构建

工具链固定为 Go 1.25.9、Node 24.15.0（`.nvmrc`）。所有命令在本目录运行。

```sh
go mod download
npm --prefix web-ui ci
make build
```

产物：`dist/herdr-bridge-server`、`dist/herdr-bridge`、`web-ui/dist/`。Go 构建不依赖前端；只构建代理可用 `go build -o dist/herdr-bridge ./client`。Windows 代理可用 `GOOS=windows GOARCH=amd64 go build -o dist/herdr-bridge.exe ./client`。

## 启动 server

提前准备 PostgreSQL 数据库与可建表的服务账号。连接串和首次管理员密码通过环境变量传入，不写入 YAML，不提供默认密码。

```sh
export HERDR_BRIDGE_DATABASE_URL='postgresql://bridge:YOUR_URL_ENCODED_PASSWORD@127.0.0.1:5432/herdr_bridge?sslmode=disable'
# 在终端交互输入强密码，不放进 shell 历史。
read -r -s -p 'Initial admin password: ' HERDR_BRIDGE_ADMIN_PASSWORD
export HERDR_BRIDGE_ADMIN_PASSWORD
./dist/herdr-bridge-server --config examples/server.local.yaml
```

打开 `http://127.0.0.1:8080/ui/`，首次以 `admin` 登录并修改密码，然后创建普通用户。密码至少 12 字节；页面要求至少 12 个字符。已有数据库启动不会覆盖管理员密码。服务端使用事务、版本表和 PostgreSQL advisory lock 执行迁移。

生产配置参考 [examples/server.yaml](examples/server.yaml)：使用 HTTPS 公网入口、安全 Cookie 和 PostgreSQL 证书校验。局域网 HTTP 访问可设置 `listen: "0.0.0.0:58182"`、`public_url: "http://你的局域网地址:58182"` 和 `cookie_secure: false`，不再限制为回环地址。`allowed_origins` 填实际访问的来源地址（协议、主机、端口）；省略时默认使用 `public_url`，通过多个 IP 或域名访问时逐项添加。`trusted_proxies` 使用 CIDR；只影响可信代理链的客户端 IP 提取，不改变 Cookie、Origin 或授权规则。

静态文件默认通过 `web_ui.directory` 提供。也可关闭 `web_ui.enabled`，由 Nginx 托管 `/ui/`，并原样转发 `/api/`、`/ws/`、`/bridge/`。只有 `/ui/` 有 SPA fallback。WebSocket 需要 Upgrade 转发、禁用代理缓冲、读超时大于心跳超时。首版仅支持单 server 实例。

## 启动代理

用户登录网页生成 Key，完整秘密仅显示一次。复制 [examples/client.json](examples/client.json)，填写服务器地址、Key 和 **hc 可执行文件的绝对路径**。

```sh
mkdir -p .local/auth .local/state
chmod 700 .local/auth .local/state
cp examples/client.json .local/auth/config.json
chmod 600 .local/auth/config.json
# 编辑上面的副本，填入 Key 和 hc 路径，再启动。
./dist/herdr-bridge --config "$PWD/.local/auth/config.json" --state-dir "$PWD/.local/state"
```

连接本机 HTTP 开发服务器时还需 `--dev`，配置 `server_url` 为 `http://127.0.0.1:8080`。未指定参数时，读取 `~/.herdr-bridge/auth/config.json`，身份保存在 `~/.herdr-bridge/state/identity.json`。

Unix auth 目录必须私有（0700），配置为 0600。Windows 配置及 auth 目录 ACL 只允许当前账号与 SYSTEM，且所有者为当前账号；可在文件属性中关闭继承并设置。代理自动为状态目录设置私有权限，使用 OS 文件锁防止重复实例。身份文件不可跨机器复制。不同本地 core 实例使用不同配置、`HC_SESSION` 和状态目录。

`core.binary` 按参数数组执行，不经过 shell；`core.session`/`core.socket` 确定子进程目标，外部 `HC_SOCKET` 和 `HC_TERMINAL_ID` 不会覆盖它。

## 使用边界

- 普通用户只能访问自己的 Key、代理与布局。管理员也不能访问其他人的终端内容。
- 一条浏览器连接对应一个隧道、一个 `hc connect`。终端地址按代理隔离，包含聚合远端的 `machine/t1`。
- 关闭标签、网页、退出登录或撤销 Key，只关闭查看连接。只有确认「结束程序」才发送 `terminal.kill`。
- 只读模式不发送输入、尺寸或焦点修改；多个可写查看窗口可能共同控制程序。
- 断线后新建隧道、重新握手、订阅快照并附着。运行命令和输入不会重放；响应丢失时结果未知，应刷新实际终端列表。
- 每个隧道有字节与消息数量上限，轮询公平发送；控制消息优先。慢隧道被单独关闭；物理连接持续阻塞则关闭整个链路。
- Key 到期在线检查间隔 1 秒；撤销和禁用立即关闭关联链路。代理配额统计当前在线连接；离线代理归属仍保留且不能被其他账号认领。
- 工作台采用 Spaces / Agents、终端、Files / Changes 三栏布局。原生空间只读导入；网页私有空间可新增、重命名和安排分屏，普通 Shell 位于空间终端或“未分组”。
- Files / Changes 通过所选机器的 core 隧道只读浏览，跟随实际聚焦终端的目录；左右侧栏可折叠，窄窗口使用工具栏切换。
- 使用「保存布局」显式保存网页布局（schemaVersion 2，兼容旧布局）；版本冲突不会覆盖另一个页面的保存。原生布局不写回，Pin/Unpin 与已读通过共享终端标签同步。
- 本轮实现范围、降级行为及验证限制见 [工作台实现记录](docs/workspace-layout-implementation.md)。

## 测试与契约

```sh
go test -race ./...
npm --prefix web-ui test
npm --prefix web-ui run typecheck
npm --prefix web-ui run build
# 首次在可联网环境安装浏览器：
cd web-ui
npx playwright install chromium
npm run test:e2e
```

PostgreSQL 集成测试默认跳过，需显式提供隔离数据库，数据库名必须以 `herdr_bridge_test` 开头。每个测试创建、删除独立 schema，不使用 SQLite。

```sh
export HERDR_BRIDGE_TEST_DATABASE_URL='postgresql://bridge:TEST_PASSWORD@127.0.0.1:5432/herdr_bridge_test?sslmode=disable'
go test -race ./server/internal
# 指向与 contracts/core/SOURCE.md 一致的 hc 构建，启用原生 core / 完整代理链路测试：
export HERDR_BRIDGE_TEST_HC='/absolute/path/to/hc'
go test -race ./...
```

core 测试使用随机 `HC_SESSION`、独立 socket 和本目录临时 XDG 状态/配置目录；清理时只停止这一个测试 core。当前原生 shell 测试针对 Unix `/bin/sh`。浏览器测试使用真实浏览器、模拟 HTTP/core 服务，测试渲染、输入、只读和结束确认；它不替代真实后端联调。Windows ConPTY、真实中文输入法与全屏 TUI 仍需按 [验证清单](docs/validation.md) 验收。

- [HTTP OpenAPI](contracts/openapi.yaml)（JSON 格式的 YAML）：浏览器接口与 CSRF/Cookie 约定。
- `npm --prefix web-ui run generate:api`：使用固定版本 openapi-typescript 重新生成类型；首次运行需可下载该工具。
- [Bridge 字节协议与生命周期](contracts/bridge/README.md)，Go/TS 共用 `vectors.json`。
- [固定 core schema 来源](contracts/core/SOURCE.md)。

`.github/workflows/ci.yml` 适用于将本目录作为仓库根目录运行的 CI；若由外层单仓管理，应在外层工作流引用这些步骤。当前会话没有触发远端 CI。
