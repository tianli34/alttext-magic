/**
 * File: vitest.config.ts
 * Purpose: Vitest 单元测试配置。
 *          仅收集 tests/unit/** 下的测试文件；
 *          tests/ 根目录下的旧式手写断言脚本（node:assert + process.exit）
 *          仍通过 tsx 单独运行，不纳入 Vitest，避免顶层副作用冲突。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 仅收集 Vitest 风格的单元测试目录
    include: ['tests/unit/**/*.test.ts'],
    // 服务端纯逻辑测试，使用 Node 环境
    environment: 'node',
    // 测试文件之间隔离执行，防止模块级单例（如 Prisma）相互污染
    isolate: true,
  },
});
