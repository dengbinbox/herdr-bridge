# herdr-bridge-server

入口 `main.go` 负责参数和启动装配。`internal/` 实现严格 YAML 配置、PostgreSQL 迁移、Argon2id 认证、Cookie/CSRF、用户/Key/布局 API、代理注册与 WebSocket 转发。

```sh
# 从 herdr-bridge 根目录执行
go build -o dist/herdr-bridge-server ./server
./dist/herdr-bridge-server --config examples/server.local.yaml
```

配置、数据库准备、静态页面与测试见 [根目录说明](../README.md)。启动需要 PostgreSQL；不提供内存或 SQLite 生产替代模式。进程仅维护当前在线路由，因此首版使用单实例。
