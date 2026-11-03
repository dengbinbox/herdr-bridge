# Web UI

React + strict TypeScript + Vite，固定 `/ui/` 基路径。使用 React Router、TanStack Query、Radix Dialog、xterm.js、CSS Modules 和 react-resizable-panels。

```sh
npm ci
npm run dev       # 127.0.0.1:5173/ui/，API/WS 代理到 127.0.0.1:8080
npm run typecheck
npm test
npm run build
npm run test:e2e  # 先构建 dist，并安装 Playwright Chromium
```

`src/core.ts` 独立处理 plain hello、framed RPC、JSON 行事件流、快照与信用流控。终端字节直接交给 xterm，完成回调后返回 CREDIT，不进入 React 状态。终端 resize 与输出按序处理；只读观察优先使用 core 的尺寸通知，旧 core 使用事件尺寸回退。

HTTP 类型来源为 `../contracts/openapi.yaml`；`npm run generate:api` 使用固定版本的 openapi-typescript。WebSocket 根据页面协议/主机推导地址，认证秘密不进入 localStorage。生产运行只需 `dist/` 静态文件，无需 Node 服务。

浏览器测试在 Playwright 中模拟同源 HTTP/core 响应，不需要额外监听端口；实际部署联调与本次检查结果见 [验证记录](../docs/validation.md)。
