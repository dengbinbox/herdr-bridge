# herdr-bridge

Go 常驻出站代理。默认读取 `~/.herdr-bridge/auth/config.json`；使用用户生成的 Key 主动连接中央服务，不需要开放入站端口。

```sh
# 从 herdr-bridge 根目录执行
go build -o dist/herdr-bridge ./client
./dist/herdr-bridge --config /absolute/path/to/config.json --state-dir /absolute/path/to/state
```

每条浏览器连接启动独立 `hc connect`。代理重连时旧子进程和隧道失效；不调用 `terminal.kill`，也不重放请求。`--dev` 明确启用 HTTP/WS 开发传输。状态目录用 OS 文件锁保护，UUID 持久化。

依赖图只包含 client 与共享协议/传输，不引入 server 数据库或前端。完整配置和权限要求见 [根目录说明](../README.md)。
