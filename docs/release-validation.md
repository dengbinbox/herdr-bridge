# v0.0.1 发布配置验证

2026-11-03，发布工作流 `.github/workflows/release.yml`。

- `actionlint v1.7.11`：通过，包含 native runner 标签、表达式和 shell 检查。
- `docker compose -f deploy/compose.yaml config --quiet`：使用临时测试环境变量，通过。
- `go test -race ./...`：通过；另启动独立临时 PostgreSQL 14 容器，设置 `HERDR_BRIDGE_TEST_DATABASE_URL` 后再次通过数据库集成测试。CI 配置使用 PostgreSQL 17.6。没有访问已有数据库或默认 core 会话。
- `PLAYWRIGHT_CHANNEL=chrome npm --prefix web-ui run test:e2e`：当前解除沙箱限制后，4 项真实 Chrome / 模拟 HTTP/core 测试通过，覆盖终端生命周期、原生空间适配、文件和 diff、手机布局和 Markdown；不代表真实 core / 原生 App 全链路验收。
- GitHub 首次 main 推送的 bridge CI：通过（运行 41645671752）。
- Docker 多阶段构建：本机 linux/amd64 成功。前端类型检查所需的 `contracts/bridge/vectors.json` 已纳入构建上下文；Go 和 npm 依赖使用固定版本。当地网络需要临时代理构建参数，代理配置没有写入 Dockerfile 或仓库。
- 镜像冒烟：以 UID/GID 10001、只读根文件系统、移除 capabilities 启动，使用独立临时 PostgreSQL 容器；数据库迁移、打包后的 `/ui/` 页面及 JS 资源、初始管理员登录与强制修改密码标记均通过。临时容器和网络已清理。
- ARM、macOS、Windows 的实际编译及 GHCR/Release 发布由 v0.0.1 标签工作流执行；本机未模拟这些架构。服务器矩阵只有原生 Linux amd64 / arm64，客户端矩阵为三种系统 × 两种架构，各 job 检查宿主架构，不使用 QEMU。

发布使用仓库自带 GITHUB_TOKEN。服务端镜像携带 OCI source 标签，与本仓库 Packages 关联。客户端全部成功、服务端多架构 manifest 发布后，Release job 校验六个归档、生成 SHA-256 文件、上传附件后解除草稿状态。
