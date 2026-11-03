# VS Code 启动

首次检出后，将 `.vscode/launch.example.json` 复制为 `.vscode/launch.json`。实际启动文件可能包含本机密码，已排除 Git 跟踪；仓库只保存使用输入提示的模板。已有本地启动文件时无需覆盖。

服务端启动配置读取根目录的 `config.yaml`。首次检出时可从 `examples/server.local.yaml` 复制创建，再填写实际监听地址和允许的来源；已有 `config.yaml` 时保留本地文件。

打开 `herdr-bridge/herdr-bridge.code-workspace`，或者直接以 `herdr-bridge` 为 VS Code 根目录。仅打开外层 `herdr` 文件夹不会自动加载子目录的 launch.json。

先安装 Go 扩展（`golang.go`）及其提示安装的 Delve 调试器，确保 VS Code 能找到 Go、Node 和 npm。在工作区终端准备依赖：

```sh
go mod download
npm --prefix web-ui ci
```

在「运行和调试」选择以下配置，按 F5：

- **Bridge: Server (local)**：提示输入 PostgreSQL 连接串与首次管理员密码，自动构建前端，启动后访问 `http://127.0.0.1:8080/ui/`。数据库需提前创建；已有账号时管理员密码输入可留空，不会重置密码。
- **Bridge: Web UI (Vite)**：启动带热更新的前端，访问 `http://127.0.0.1:5173/ui/`，API 与 WebSocket 转发到本机 8080。
- **Bridge: Server + Web UI**：同时启动服务端和 Vite。
- **Bridge: Agent (local)**：使用程序默认路径，读取当前用户的 `~/.herdr-bridge/auth/config.json`，身份保存在 `~/.herdr-bridge/state/`，显式启用 HTTP 开发模式。先登录网页生成 Key，再创建私有配置，填写 Key、hc 绝对路径和实际服务端地址（例如 `http://192.168.137.106:58182`）。Unix 下 auth 目录使用 0700、配置使用 0600。启动配置不再覆盖配置文件和状态目录路径。

调试器启动程序前仍需可用的真实依赖和 PostgreSQL；这些配置不会自动安装数据库或创建代理凭据。连接串和管理员密码通过掩码输入传入进程，不写入启动配置文件。
