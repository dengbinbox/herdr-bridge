# herdr-bridge

Go 常驻出站代理。默认读取 `~/.herdr-bridge/auth/config.json`；使用用户生成的 Key 主动连接中央服务，不需要开放入站端口。

## 使用 Release 包

解压后包含 `herdr-bridge`（Windows 为 `herdr-bridge.exe`）、`config.example.json`、本说明和记录版本/提交的 `VERSION`。

先安装 herdr-core 的 `hc`。将 `config.example.json` 复制到默认配置路径，填写 `server_url`、网页生成的 `key` 和 `core.binary`（hc 绝对路径）。Unix 配置目录设为 0700、文件设为 0600；Windows 使用仅允许当前用户与 SYSTEM 的 ACL。

Linux / macOS 运行 `./herdr-bridge`，Windows PowerShell 运行 `.\herdr-bridge.exe`。HTTP 服务器地址需要额外加 `--dev`，HTTPS 不加。完整的复制、权限设置和快速运行命令见 [私有化部署文档](https://github.com/dengbinbox/herdr-bridge/blob/main/docs/deployment.md)。客户端不包含 hc，也不包含服务端。

## 从源码构建

```sh
# 从 herdr-bridge 根目录执行
go build -o dist/herdr-bridge ./client
./dist/herdr-bridge --config /absolute/path/to/config.json --state-dir /absolute/path/to/state
```

每条浏览器连接启动独立 `hc connect`。代理重连时旧子进程和隧道失效；不调用 `terminal.kill`，也不重放请求。`--dev` 明确启用 HTTP/WS 开发传输。状态目录用 OS 文件锁保护，UUID 持久化。

依赖图只包含 client 与共享协议/传输，不引入 server 数据库或前端。完整配置和权限要求见 [客户端配置与运行](https://github.com/dengbinbox/herdr-bridge/blob/main/docs/client.md)。

## 后台运行与断线重连

使用 `herdr-bridge --background`（Windows：`.\herdr-bridge.exe --background`）后台启动，可与 `--config`、`--state-dir`、`--dev` 一起使用。启动命令在配置加载完成、身份锁获取成功后返回进程号；这不代表已连接服务器。关闭终端后客户端继续运行，不会自动设置开机启动。

后台日志追加写入状态目录的 `bridge.log`（默认 `~/.herdr-bridge/state/bridge.log`）。同一状态目录只允许一个实例。停止时，Linux / macOS 使用 `kill <进程号>`，Windows PowerShell 使用 `Stop-Process -Id <进程号>`。

前台和后台均自动重试首次连接失败或网络断开，默认间隔为 **1s → 5s → 25s → 125s → 600s**，之后每 10 分钟重试一次，没有重试次数限制。连接持续超过 1 分钟后断开，间隔重新从 1 秒开始。日志会显示下一次重试间隔；Key 无效、注册被拒绝等不可恢复错误会退出。

配置中的 `connection.reconnect_min_seconds` 默认是 `1`，`connection.reconnect_max_seconds` 默认是 `600`，最大允许 `600`。已有配置若显式填写 `30`，仍按 30 秒封顶；要采用 10 分钟上限，请改为 `600` 或删除该字段。
