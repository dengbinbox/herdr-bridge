# 测试与契约

[返回文档目录](README.md) · [返回项目说明](../README.md)

所有命令均在仓库根目录执行，先按 [源码构建说明](development.md) 安装依赖。

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

core 测试使用随机 `HC_SESSION`、独立 socket 和本目录临时 XDG 状态/配置目录；清理时只停止这一个测试 core。当前原生 shell 测试针对 Unix `/bin/sh`。浏览器测试使用真实浏览器、模拟 HTTP/core 服务，测试渲染、输入、只读和结束确认；它不替代真实后端联调。Windows ConPTY、真实中文输入法与全屏 TUI 仍需按 [验证清单](validation.md) 验收。

- [HTTP OpenAPI](../contracts/openapi.yaml)（JSON 格式的 YAML）：浏览器接口与 CSRF/Cookie 约定。
- `npm --prefix web-ui run generate:api`：使用固定版本 openapi-typescript 重新生成类型；首次运行需可下载该工具。
- [Bridge 字节协议与生命周期](../contracts/bridge/README.md)，Go/TS 共用 `vectors.json`。
- [固定 core schema 来源](../contracts/core/SOURCE.md)。

`.github/workflows/ci.yml` 适用于将本目录作为仓库根目录运行的 CI；若由外层单仓管理，应在外层工作流引用这些步骤。标签发布流程见 [发布说明](release.md)。

`examples/client.json` 和 `examples/server.yaml` 是标准测试配置模板，见 [配置目录说明](../examples/README.md)。本地代理读取根目录 `client.json`，服务端和入口联调读取根目录 `config.yaml`；这两个本地文件均不纳入 Git。`TestLocalConfig` 直接检查根配置（使用测试入口密钥，不连接数据库）；边界条件单元测试继续使用隔离的最小配置。数据库集成测试使用独立测试数据库和 schema，避免操作根配置指向的实际数据库。
