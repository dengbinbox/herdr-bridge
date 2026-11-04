# 源码构建与本地运行

[返回文档目录](README.md) · [返回项目说明](../README.md)

所有命令均在仓库根目录执行。

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

生产配置参考 [examples/server.yaml](../examples/server.yaml)：使用 HTTPS 公网入口、安全 Cookie 和 PostgreSQL 证书校验。局域网 HTTP 访问可设置 `listen: "0.0.0.0:58182"`、`public_url: "http://你的局域网地址:58182"` 和 `cookie_secure: false`，不再限制为回环地址。`allowed_origins` 填实际访问的来源地址（协议、主机、端口）；省略时默认使用 `public_url`，通过多个 IP 或域名访问时逐项添加。`trusted_proxies` 使用 CIDR；只影响可信代理链的客户端 IP 提取，不改变 Cookie、Origin 或授权规则。

静态文件默认通过 `web_ui.directory` 提供。也可关闭 `web_ui.enabled`，由 Nginx 托管 `/ui/`，并原样转发 `/api/`、`/ws/`、`/bridge/`。只有 `/ui/` 有 SPA fallback。WebSocket 需要 Upgrade 转发、禁用代理缓冲、读超时大于心跳超时。首版仅支持单 server 实例。

代理启动见 [客户端配置与运行](client.md)，验证命令见 [测试与契约](testing.md)。
