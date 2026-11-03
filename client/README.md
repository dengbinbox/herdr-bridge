# herdr-bridge

Go 常驻出站代理。默认读取 `~/.herdr-bridge/auth/config.json`；使用用户生成的 Key 主动连接中央服务，不需要开放入站端口。

## 使用 Release 包

解压后包含 `herdr-bridge`（Windows 为 `herdr-bridge.exe`）、`config.example.json`、本说明和记录版本/提交的 `VERSION`。

先安装 herdr-core 的 `hc`。将 `config.example.json` 复制到默认配置路径，填写 `server_url`、网页生成的 `key` 和 `core.binary`（hc 绝对路径）。Unix 配置目录设为 0700、文件设为 0600；Windows 使用仅允许当前用户与 SYSTEM 的 ACL。

Linux / macOS 运行 `./herdr-bridge`，Windows PowerShell 运行 `.\herdr-bridge.exe`。HTTP 服务器地址需要额外加 `--dev`，HTTPS 不加。完整的复制、权限设置和快速运行命令见 [在线 README](https://github.com/dengbinbox/herdr-bridge#快速运行无需本地编译)。客户端不包含 hc，也不包含服务端。

## 从源码构建

```sh
# 从 herdr-bridge 根目录执行
go build -o dist/herdr-bridge ./client
./dist/herdr-bridge --config /absolute/path/to/config.json --state-dir /absolute/path/to/state
```

每条浏览器连接启动独立 `hc connect`。代理重连时旧子进程和隧道失效；不调用 `terminal.kill`，也不重放请求。`--dev` 明确启用 HTTP/WS 开发传输。状态目录用 OS 文件锁保护，UUID 持久化。

依赖图只包含 client 与共享协议/传输，不引入 server 数据库或前端。完整配置和权限要求见 [项目说明](https://github.com/dengbinbox/herdr-bridge#启动代理)。
