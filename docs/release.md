# 标签自动发布

[返回文档目录](README.md) · [返回项目说明](../README.md)

推送 `vX.Y.Z`（或 `vX.Y.Z-预发布标识`）标签触发 `.github/workflows/release.yml`：先通过 Go / Web / 浏览器 CI，再执行原生构建。服务端使用 `ubuntu-24.04` / `ubuntu-24.04-arm` 分别构建镜像，合并 manifest 后发布到 GHCR，镜像 source 标签关联本仓库 Packages。客户端分别使用 Linux x64 / ARM64、macOS Intel / Apple Silicon、Windows x64 / ARM64 runner；检查 `GOHOSTOS` / `GOHOSTARCH`，不使用 QEMU，也不在 x86 runner 模拟 ARM。

发布依靠仓库自带 `GITHUB_TOKEN` 的 `packages: write` 和 `contents: write` 权限，不需要额外的 PAT secret。六个客户端归档和 SHA-256 校验文件齐全后才发布 Release。工作流可在 Actions 中重跑；并发的同标签发布串行执行。

发布产物的安装方法见 [私有化部署](deployment.md)，发布验收见 [发布验证记录](release-validation.md)。
