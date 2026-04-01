

# AltText Magic — AI编程项目上下文

## 项目定位
Shopify Admin Embedded App，为商家图片自动生成 Alt Text。核心闭环：**扫描 → AI生成 → 审阅编辑 → 写回Shopify**。

## 技术栈
- **Runtime**: Node.js + TypeScript
- **Web**: React Router + Shopify App Bridge + Polaris Web Components
- **ORM**: Prisma + PostgreSQL
- **Queue**: Redis + BullMQ
- **部署**: Railway (web / worker / postgres / redis)

## 4类图片资源 & 3个Alt Plane
| 资源类型 | alt_plane | 写回mutation |
|---|---|---|
| Product Media | `FILE_ALT` | `fileUpdate` |
| Files | `FILE_ALT` | `fileUpdate` |
| Collection Image | `COLLECTION_IMAGE_ALT` | `collectionUpdate` |
| Article Image | `ARTICLE_IMAGE_ALT` | `articleUpdate` |

> Product Media 与 Files 共享 `FILE_ALT` plane，同一 MediaImage 只产生1条 candidate，引用关系在 `image_usage` 展开。

## 核心数据模型关系
```
shops → scan_job → scan_task → scan_task_attempt → staging表
                                                  ↓ derive
                                    scan_result_target / scan_result_usage
                                                  ↓ publish(原子事务)
alt_target ←1:1→ alt_candidate ←1:N→ candidate_group_projection
    ↑1:N                                  (展示投影, 按group_type分组)
image_usage (usage_type: PRODUCT/FILE)
    
alt_candidate ←1:1→ alt_draft
alt_target ←1:1→ decorative_mark
```

**Candidate唯一键**: `(shop_id, alt_plane, write_target_id, locale)`

**Candidate状态机**: `MISSING → GENERATED → WRITTEN → RESOLVED`，支持 `GENERATION_FAILED_RETRYABLE` / `WRITEBACK_FAILED_RETRYABLE` / `DECORATIVE_SKIPPED` / `SKIPPED_ALREADY_FILLED` / `NOT_FOUND`

## scope_flags 三层闭环
- **scan_scope_flags**: 用户当前配置(可独立修改)
- **last_published_scope_flags**: 已发布结果实际覆盖的类型
- **effective_read_scope_flags**: `intersection(scan, last_published)` → 控制前台展示/生成/写回/增量gate

## 扫描机制
- **全量**: Shopify GraphQL Bulk Operations，4个task并行，NDJSON流式解析
- **待发布+原子发布**: 先写 `scan_result_*`，job完成后单事务publish到 `alt_target/image_usage/alt_candidate/candidate_group_projection`
- **PARTIAL_SUCCESS**: 仅成功资源类型做sweep替换，失败类型保留旧数据
- **Bulk attempt隔离**: URL过期按attempt级重跑，旧失败attempt不参与derive
- **增量(仅付费)**: Webhook → debounce/coalesce → 4重gate(互斥锁/计划/scope/图片指纹sha256) → 原子patch已发布结果

## 生成与写回关键约束
- **生成前**: 实时复核Shopify当前Alt真值，已非空则跳过不调AI不扣费
- **写回前**: 二次读校验，防覆盖外部新增Alt
- **共享文件上下文**: usage=1用`RESOURCE_SPECIFIC`，usage>1用`SHARED_NEUTRAL`(中性prompt)
- **Alt输出**: 英文，≤125字符
- **Shop级互斥锁**: SCAN/GENERATE/WRITEBACK三者互斥，webhook增量受锁延迟

## 计费模型
- **5档**: Free($0,25/月) / Starter($4.99,150/月) / Growth($9.99,350/月) / Pro($14.99,800/月) / Max($24.99,2000/月)
- **年付**: 一次性发放12×月配额到`ANNUAL_INCLUDED` bucket
- **Free月配额**: UTC自然月发放，`cycle_key=FREE:YYYY-MM`防重，不跨月结转
- **欢迎额度**: 安装50 + 首次付费按计划发放一次(200~3000)
- **超额包**: 手动购买，不自动超扣
- **额度消费顺序**: included(最早到期优先) → 欢迎 → 超额包
- **预留机制**: batch启动前原子预留 → 逐条consume → 结束释放剩余
- **扫描不计费，成功生成即扣1**

## 关键表(26张)
`shops` / `scan_notice_ack` / `shop_operation_lock` / `scan_job` / `scan_task` / `scan_task_attempt` / `stg_product` / `stg_media_image_product` / `stg_media_image_file` / `stg_collection` / `stg_article` / `scan_result_target` / `scan_result_usage` / `alt_target` / `image_usage` / `decorative_mark` / `alt_candidate` / `candidate_group_projection` / `alt_draft` / `audit_log` / `webhook_event` / `resource_image_fingerprint` / `job_batch` / `job_item` / `billing_subscription` / `overage_pack_purchase` / `credit_bucket` / `credit_reservation` / `credit_reservation_line` / `credit_ledger` / `billing_ledger`

## 关键API
- `GET /api/bootstrap` — 初始化状态
- `POST /api/settings/scope` — 独立修改scope
- `POST /api/scan/start` — 启动全量扫描
- `GET /api/dashboard` — 分组统计(基于candidate_group_projection)
- `GET /api/candidates?group=&status=` — 候选列表
- `POST /api/generation/start` — AI生成(带preflight)
- `POST /api/writeback/start` — 写回Shopify
- `POST /api/decorative/mark|unmark` — 装饰性标记
- `GET /api/sse?batchId=` — 进度推送

## Webhooks
`APP_UNINSTALLED` / GDPR×3 / `BULK_OPERATIONS_FINISH` / `products/create|update` / `collections/create|update` / 计费回调

## BullMQ队列
`scan_start` / `parse_bulk_to_staging` / `derive_scan_attempt_to_result` / `publish_scan_result` / `continuous_scan_debounce` / `continuous_scan_product|collection` / `generate_alt` / `writeback` / `billing_sync` / `quota_grant` / `reservation_reaper` / `cleanup` / `gdpr_delete`

## 数据留存
扫描结果保留最新1份 / 草稿30天 / 审计90天 / decorative持久化 / staging&scan_result 7天 / 卸载即删全量



