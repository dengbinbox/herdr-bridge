# 客户端配置与运行

[返回文档目录](README.md) · [返回项目说明](../README.md)

Release 客户端下载和首次配置见 [私有化部署](deployment.md)。以下命令使用源码构建产物，构建方法见 [源码构建与本地运行](development.md)。

## 启动代理

用户登录网页生成 Key，完整秘密仅显示一次。复制 [examples/client.json](../examples/client.json)，填写服务器地址、Key 和 **hc 可执行文件的绝对路径**。

```sh
mkdir -p .local/auth .local/state
cp examples/client.json .local/auth/config.json
# 编辑上面的副本，填入 Key 和 hc 路径，再启动。
./dist/herdr-bridge --config "$PWD/.local/auth/config.json" --state-dir "$PWD/.local/state"
```

连接本机 HTTP 开发服务器时还需 `--dev`，配置 `server_url` 为 `http://127.0.0.1:8080`。未指定参数时，读取 `~/.herdr-bridge/auth/config.json`，身份保存在 `~/.herdr-bridge/state/identity.json`。

客户端不检查配置文件、父目录或身份文件的 Unix 权限位及 Windows ACL；运行账号能够正常读取文件即可。代理自动为状态目录设置私有权限，使用 OS 文件锁防止重复实例。身份文件不可跨机器复制。不同本地 core 实例使用不同配置、`HC_SESSION` 和状态目录。

`core.binary` 按参数数组执行，不经过 shell；`core.session`/`core.socket` 确定子进程目标，外部 `HC_SOCKET` 和 `HC_TERMINAL_ID` 不会覆盖它。

## 后台运行与断线重连

使用 `herdr-bridge --background`（Windows：`.\herdr-bridge.exe --background`）后台启动，可与 `--config`、`--state-dir`、`--dev` 一起使用。启动命令在配置加载完成、身份锁获取成功后返回进程号；这不代表已连接服务器。关闭终端后客户端继续运行，不会自动设置开机启动。

后台日志追加写入状态目录的 `bridge.log`（默认 `~/.herdr-bridge/state/bridge.log`）。同一状态目录只允许一个实例。停止时，Linux / macOS 使用 `kill <进程号>`，Windows PowerShell 使用 `Stop-Process -Id <进程号>`。

前台和后台均自动重试首次连接失败或网络断开，默认间隔为 **1s → 5s → 25s → 125s → 600s**，之后每 10 分钟重试一次，没有重试次数限制。连接持续超过 1 分钟后断开，间隔重新从 1 秒开始。日志会显示下一次重试间隔；Key 无效、注册被拒绝等不可恢复错误会退出。

配置中的 `connection.reconnect_min_seconds` 默认是 `1`，`connection.reconnect_max_seconds` 默认是 `600`，最大允许 `600`。已有配置若显式填写 `30`，仍按 30 秒封顶；要采用 10 分钟上限，请改为 `600` 或删除该字段。

## 私有入口 Cookie

客户端配置可添加 `"entry_url": "https://bridge.example.com/hello/key?ttt=独立入口密钥"`。
默认留空，直接使用原有 Key 连接；服务端开启入口保护时必须填写完整地址。
网页生成 Key 时此字段始终为空，入口地址由成员线下交换，系统不展示、分发或推断它。

入口地址必须与 `server_url` 同源；HTTP 仍需 `--dev`。每次连接和重连前先访问入口，获取 Cookie 后携带 Cookie 和原有 Bearer Key 建立 WebSocket，不跟随入口跳转。入口获取失败时不会尝试连接，按原有策略重试。Cookie 仅保存在内存，不写入配置或日志。
