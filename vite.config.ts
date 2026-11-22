import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // vite.config 不自动加载 .env，需 loadEnv 显式读取；端口语义与 server/index.ts 保持一致，
  // 否则 .env 覆盖 PORT 后 dev 代理会静默失效
  const env = loadEnv(mode, process.cwd(), "");
  const portRaw = Number(env.PORT || 3001);
  const port = Number.isFinite(portRaw) && portRaw > 0 ? portRaw : 3001; // PORT 非数字时回退，否则 proxy target 变 localhost:NaN 静默断代理
  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: true, // 监听 0.0.0.0 允许局域网/公网访问；/api/* 无鉴权，公网暴露有数据与操作风险，仅在可信网络开启
      proxy: {
        "/api": {
          target: `http://localhost:${port}`,
          changeOrigin: true,
        },
      },
    },
  };
});
