/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    testTimeout: 30_000,
    // 性能契约用例以墙钟计时（<4s）：与 jsdom UI 用例并行会互相争抢 CPU 导致偶发超时，
    // 故全部测试文件在单进程内顺序执行，保证计时公平、结果确定。
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
