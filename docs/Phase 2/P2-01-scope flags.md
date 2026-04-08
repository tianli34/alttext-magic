已读取文件：
- [E:\alttext-magic\docs\Specs\tree.txt](E:\alttext-magic\docs\Specs\tree.txt)
- [E:\alttext-magic\docs\STATUS.md](E:\alttext-magic\docs\STATUS.md)
- [E:\alttext-magic\package.json](E:\alttext-magic\package.json)
- [E:\alttext-magic\prisma\schema.prisma](E:\alttext-magic\prisma\schema.prisma)
- [E:\alttext-magic\tsconfig.json](E:\alttext-magic\tsconfig.json)
- [E:\alttext-magic\tsconfig.worker.json](E:\alttext-magic\tsconfig.worker.json)
- [E:\alttext-magic\server\config\constants.ts](E:\alttext-magic\server\config\constants.ts)
- [E:\alttext-magic\server\modules\shop\shop.types.ts](E:\alttext-magic\server\modules\shop\shop.types.ts)
- [E:\alttext-magic\server\modules\shop\scope.service.ts](E:\alttext-magic\server\modules\shop\scope.service.ts)
- [E:\alttext-magic\server\modules\shop\shop.service.ts](E:\alttext-magic\server\modules\shop\shop.service.ts)
- [E:\alttext-magic\app\lib\scope-utils.ts](E:\alttext-magic\app\lib\scope-utils.ts)
- [E:\alttext-magic\app\routes\api.settings.scope.tsx](E:\alttext-magic\app\routes\api.settings.scope.tsx)
- [E:\alttext-magic\app\components\settings\ScopeSettings.tsx](E:\alttext-magic\app\components\settings\ScopeSettings.tsx)
- [E:\alttext-magic\app\routes\app.onboarding.tsx](E:\alttext-magic\app\routes\app.onboarding.tsx)
- [E:\alttext-magic\app\routes\app.settings.tsx](E:\alttext-magic\app\routes\app.settings.tsx)
- [E:\alttext-magic\tests\scope-utils.test.ts](E:\alttext-magic\tests\scope-utils.test.ts)

已补上共享 `scope flags` 工具，放在 [app/lib/scope-utils.ts](E:\alttext-magic\app\lib\scope-utils.ts#L1)。现在提供：
- `isScopeFlag`
- `dedupeScopeFlags`
- `sortScopeFlags`
- `normalizeScopeFlags`
- `parseScopeFlags`
- `safeParseScopeFlags`

实现基于 `zod` 做校验，并统一按 `PRODUCT_MEDIA -> FILES -> COLLECTION_IMAGE -> ARTICLE_IMAGE` 的规范顺序输出。

另外加了断言测试脚本 [tests/scope-utils.test.ts](E:\alttext-magic\tests\scope-utils.test.ts#L1)，并把完成项写入了 [docs/STATUS.md](E:\alttext-magic\docs\STATUS.md#L11)。

验证结果：
- `pnpm.cmd typecheck` 通过
- 测试脚本在当前沙箱里执行失败，原因是环境禁止 `tsx/esbuild` 派生子进程，报 `spawn EPERM`；不是类型错误

补充说明：
- 我读取的文档之间未发现冲突
- 但当前实现里存在一处代码层面的表示不一致：`server/modules/shop/scope.service.ts` 仍是旧的布尔 bitmask 方案，而这次新增工具使用的是字符串枚举 `PRODUCT_MEDIA/...`。这次我没有改动旧 bitmask 逻辑，只补了你要的校验/去重/排序工具。如果你要，我下一步可以把两套表示统一掉。