import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  // vite.config 不自动加载 .env，需 loadEnv 显式读取；端口语义与 server/index.ts 保持一致，
  // 否则 .env 覆盖 PORT 后 dev 代理会静默失效
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.PORT || 3001);
  return {
    plugins: [react()],
    server: {
      port: 5173,
      host: true, // 监听 0.0.0.0，允许通过公网 IP 访问（默认仅 localhost）
      proxy: {
        "/api": {
          target: `http://localhost:${port}`,
          changeOrigin: true,
        },
      },
    },
  };
});
