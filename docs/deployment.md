# 私有化部署（无需本地编译）

[返回文档目录](README.md) · [返回项目说明](../README.md)

标签 `v0.0.1` 的 Actions 完成后：

- 服务端镜像（包含网页）：`ghcr.io/dengbinbox/herdr-bridge:v0.0.1`，支持 Linux amd64 / arm64，Docker 自动选择架构；稳定版本另更新 `latest`。
- [仓库 Packages](https://github.com/dengbinbox/herdr-bridge/pkgs/container/herdr-bridge)：服务端镜像。
- [GitHub Releases](https://github.com/dengbinbox/herdr-bridge/releases)：Windows、macOS、Linux 的 amd64 / arm64 客户端及 `sha256sums.txt`。

### 服务端：Docker Compose

安装 Docker Engine / Desktop 和 Compose 插件。在 Linux / macOS 终端执行：

```sh
mkdir herdr-bridge-run
cd herdr-bridge-run
curl -fsSLO https://raw.githubusercontent.com/dengbinbox/herdr-bridge/v0.0.1/deploy/compose.yaml
curl -fsSLO https://raw.githubusercontent.com/dengbinbox/herdr-bridge/v0.0.1/deploy/server.yaml
# 首次部署生成随机密码；升级时保留已有 .env，不要重新生成。
# 不将实际密码写入 shell 历史，保持该文件私有。
umask 077
printf 'HERDR_BRIDGE_VERSION=v0.0.1\nPOSTGRES_PASSWORD=%s\nHERDR_BRIDGE_ADMIN_PASSWORD=%s\n' \
  "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > .env
docker compose up -d
# 查看启动及迁移结果
docker compose logs --tail=50 server
```

打开 `http://localhost:8080/ui/`，用户名 `admin`，初始密码为 `.env` 中的 `HERDR_BRIDGE_ADMIN_PASSWORD`（用本地编辑器查看）。首次登录修改密码，创建普通用户；普通用户登录后在“连接 Key”页面生成代理 Key。数据库使用持久卷，`docker compose down` 保留数据；升级时修改 `.env` 中的版本，再执行 `docker compose pull && docker compose up -d`。

若 GHCR 包尚为私有，仓库管理员可在 Packages → Package settings 将包设为 Public；或先 `docker login ghcr.io`，使用具有 `read:packages` 的 GitHub token。私有仓库的示例文件可通过已认证的 Git clone 获取。

默认端口只绑定服务端本机。局域网访问时，将 `compose.yaml` 端口改成 `"8080:8080"`，同时把 `server.yaml` 的 `server.public_url` 改成实际地址，例如 `http://192.168.1.10:8080`，随后重建服务：`docker compose up -d --force-recreate server`。公网部署请使用 HTTPS 反向代理，并将 `public_url` 改为 HTTPS、`cookie_secure` 改为 `true`；WebSocket 转发和完整服务端配置见 [服务端配置说明](development.md#启动-server)。数据库无需暴露端口。

### 客户端：下载、配置、运行

每台需要访问的机器运行一个客户端。先单独安装 **herdr-core 的 `hc`**；Release 中的 `herdr-bridge` 是连接代理，不包含 core。下载与机器匹配的包：

| 系统 | x86-64 | ARM64 |
| --- | --- | --- |
| Windows | `herdr-bridge_v0.0.1_windows_amd64.zip` | `herdr-bridge_v0.0.1_windows_arm64.zip` |
| macOS | `herdr-bridge_v0.0.1_darwin_amd64.tar.gz` | `herdr-bridge_v0.0.1_darwin_arm64.tar.gz`（Apple Silicon） |
| Linux | `herdr-bridge_v0.0.1_linux_amd64.tar.gz` | `herdr-bridge_v0.0.1_linux_arm64.tar.gz` |

下载地址：`https://github.com/dengbinbox/herdr-bridge/releases/download/v0.0.1/<上表文件名>`。下载 `sha256sums.txt` 后可用 Linux `sha256sum`、macOS `shasum -a 256` 或 PowerShell `Get-FileHash -Algorithm SHA256` 对照校验。macOS / Windows 包未做代码签名或公证。

Linux / macOS：解压对应 tar.gz，进入解压目录，然后执行：

```sh
mkdir -p "$HOME/.herdr-bridge/auth" "$HOME/.herdr-bridge/state"
chmod 700 "$HOME/.herdr-bridge/auth" "$HOME/.herdr-bridge/state"
cp config.example.json "$HOME/.herdr-bridge/auth/config.json"
chmod 600 "$HOME/.herdr-bridge/auth/config.json"
# 用编辑器填写配置，字段说明见本节末尾，再启动
./herdr-bridge
# 若 server_url 是 HTTP（包括局域网），显式允许开发连接：
# ./herdr-bridge --dev
```

Windows：解压 zip，用当前普通用户的 PowerShell 进入解压目录：

```powershell
$authDir = Join-Path $env:USERPROFILE '.herdr-bridge\auth'
New-Item -ItemType Directory -Force $authDir | Out-Null
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $authDir /inheritance:r /grant:r "${account}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F'
Copy-Item .\config.example.json (Join-Path $authDir 'config.json')
icacls (Join-Path $authDir 'config.json') /inheritance:r /grant:r "${account}:F" 'SYSTEM:F'
notepad (Join-Path $authDir 'config.json')
.\herdr-bridge.exe
# HTTP server_url 使用：.\herdr-bridge.exe --dev
```

配置至少修改 `server_url`、`key`、`core.binary`：服务器地址必须是这台客户端可访问的地址；Key 从网页复制；`core.binary` 填 `hc` 的绝对路径（Windows JSON 中反斜杠写成 `\\`，也可用 `C:/tools/hc.exe`）。`core.session` 默认 `default`，可换成自己的会话。启动后机器会出现在网页列表中。状态目录由程序自动创建和保护，不要将身份文件复制到另一台机器。

后台运行、日志与重连设置见 [客户端配置与运行](client.md)。
