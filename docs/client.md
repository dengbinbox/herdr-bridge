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

默认后台运行，关闭终端后继续运行；不会自动设置开机启动。支持以下命令（Windows 使用 `herdr-bridge.exe`）：

```sh
herdr-bridge                 # 默认后台启动，等同于 start
herdr-bridge start           # 后台启动
herdr-bridge --foreground    # 前台运行，Ctrl+C 停止
herdr-bridge stop            # 优雅停止，已停止时也成功
herdr-bridge restart         # 停止后重新后台启动
herdr-bridge status          # 查看运行状态、PID、配置和日志路径
```

子命令放在参数前，可通过 `--state-dir` 选择实例。`start/restart` 支持 `--config`、`--dev` 和 `--foreground`；旧参数 `--background` 继续兼容，但不能与 `--foreground` 同时使用。

`restart` 默认沿用运行实例的配置路径和 `--dev` 设置，显式参数可覆盖（`--dev=false` 关闭开发模式）；实例未运行时使用默认或指定配置启动。重启前先验证配置，停止超时则报错，不强制杀进程。`stop/status` 不依赖配置文件有效。旧版客户端没有本地控制接口，需先按原方式停止并升级。

后台日志追加写入状态目录的 `bridge.log`（默认 `~/.herdr-bridge/state/bridge.log`），前台日志输出到终端。启动命令在配置加载、身份锁和本机控制接口就绪后返回 PID，不代表已连接服务器。`status` 的运行状态也不代表服务器连接状态。

同一状态目录只允许一个实例。本机控制接口仅监听 `127.0.0.1` 的随机端口，通过私有状态文件中的随机令牌认证。停止会关闭代理连接与 `hc connect` 子进程，不停止 herdr-core 服务或删除终端会话。

前台和后台均自动重试首次连接失败或网络断开，默认间隔为 **1s → 5s → 25s → 125s → 600s**，之后每 10 分钟重试一次，没有重试次数限制。连接持续超过 1 分钟后断开，间隔重新从 1 秒开始。日志会显示下一次重试间隔；Key 无效、注册被拒绝等不可恢复错误会退出。

配置中的 `connection.reconnect_min_seconds` 默认是 `1`，`connection.reconnect_max_seconds` 默认是 `600`，最大允许 `600`。已有配置若显式填写 `30`，仍按 30 秒封顶；要采用 10 分钟上限，请改为 `600` 或删除该字段。

## 私有入口 Cookie

客户端配置可添加 `"entry_url": "https://bridge.example.com/hello/key?ttt=独立入口密钥"`。
默认留空，直接使用原有 Key 连接；服务端开启入口保护时必须填写完整地址。
网页生成 Key 时此字段始终为空，入口地址由成员线下交换，系统不展示、分发或推断它。

入口地址必须与 `server_url` 同源；HTTP 仍需 `--dev`。每次连接和重连前先访问入口，获取 Cookie 后携带 Cookie 和原有 Bearer Key 建立 WebSocket，不跟随入口跳转。入口获取失败时不会尝试连接，按原有策略重试。Cookie 仅保存在内存，不写入配置或日志。
