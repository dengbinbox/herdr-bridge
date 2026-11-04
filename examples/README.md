# 标准测试配置

此目录保存可提交的客户端和服务端标准测试配置模板，仅包含示例地址、占位符和环境变量名，不包含本地凭据。

| 标准模板 | 本地测试文件 | 用途 |
| --- | --- | --- |
| `client.json` | 根目录 `client.json` | 客户端连接测试及 VS Code Agent 启动 |
| `server.yaml` | 根目录 `config.yaml` | 服务端测试及 VS Code Server 启动 |

首次使用时从仓库根目录复制；已有本地文件不要覆盖：

```sh
cp -n examples/client.json client.json
cp -n examples/server.yaml config.yaml
```

按实际环境调整服务端地址、数据库环境变量、客户端 Key 和本机 hc 绝对路径。HTTP 测试需设置服务端 `auth.cookie_secure: false`，客户端使用 `--dev`。启用入口保护后，客户端自行填写线下获取的完整 `entry_url`；模板始终留空。

根目录 `client.json` 和 `config.yaml` 被 Git 忽略，仅用于本地测试。修改公共默认值或新增字段时更新本目录模板；不要将本地密钥复制回模板。
