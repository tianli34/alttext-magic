/**
 * File: tests/dashboard.service.test.ts
 * Purpose: Dashboard 统计服务单测，覆盖 scope 过滤、空 scope 和扫描状态返回。
 */
import assert from "node:assert/strict";
import { CandidateGroupType } from "@prisma/client";
import {
  getDashboardData,
  mapScopeFlagsToGroupTypes,
  type DashboardDataAccess,
} from "../server/modules/dashboard/dashboard.service";
import type { ScanScopeFlags } from "../server/modules/shop/shop.types";

const allScopes: ScanScopeFlags = {
  PRODUCT_MEDIA: true,
  FILES: true,
  COLLECTION_IMAGE: true,
  ARTICLE_IMAGE: true,
};

async function run(): Promise<void> {
  {
    const groups = mapScopeFlagsToGroupTypes({
      PRODUCT_MEDIA: true,
      FILES: false,
      COLLECTION_IMAGE: true,
      ARTICLE_IMAGE: false,
    });

    assert.deepEqual(
      groups,
      [CandidateGroupType.PRODUCT_MEDIA, CandidateGroupType.COLLECTION],
      "scope flag 应映射为对应 candidate group type",
    );
  }

  {
    let capturedAllowedGroups: readonly CandidateGroupType[] = [];
    const dataAccess: DashboardDataAccess = {
      async getShop() {
        return {
          scanScopeFlags: allScopes,
          lastPublishedScopeFlags: {
            PRODUCT_MEDIA: true,
            FILES: true,
            COLLECTION_IMAGE: false,
            ARTICLE_IMAGE: false,
          },
          lastPublishedAt: new Date("2026-04-20T08:00:00.000Z"),
        };
      },
      async getGroupStats(_shopId, allowedGroups) {
        capturedAllowedGroups = allowedGroups;
        return [
          {
            groupType: CandidateGroupType.PRODUCT_MEDIA,
            total: 3,
            hasAlt: 1,
            missing: 1,
            decorative: 1,
            pending: 1,
            generated: 0,
          },
          {
            groupType: CandidateGroupType.FILES,
            total: 2,
            hasAlt: 0,
            missing: 2,
            decorative: 0,
            pending: 1,
            generated: 1,
          },
        ];
      },
      async getActiveScanJobId() {
        return "scan-job-running-id";
      },
    };

    const data = await getDashboardData("shop-1", dataAccess);

    assert.deepEqual(
      capturedAllowedGroups,
      [CandidateGroupType.PRODUCT_MEDIA, CandidateGroupType.FILES],
      "统计查询只应接收 effective_read_scope_flags 内的分组",
    );
    assert.deepEqual(
      data.groups.map((group) => group.groupType),
      [CandidateGroupType.PRODUCT_MEDIA, CandidateGroupType.FILES],
      "响应 groups 只包含 scope 内分组",
    );
    assert.equal(
      data.lastPublishedAt,
      "2026-04-20T08:00:00.000Z",
      "lastPublishedAt 应序列化为 ISO 字符串",
    );
    assert.equal(data.isScanning, true, "RUNNING scan_job 应返回 isScanning=true");
    assert.equal(data.activeScanJobId, "scan-job-running-id", "RUNNING scan_job 应返回 activeScanJobId");
  }

  {
    let groupQueryCalled = false;
    const dataAccess: DashboardDataAccess = {
      async getShop() {
        return {
          scanScopeFlags: allScopes,
          lastPublishedScopeFlags: null,
          lastPublishedAt: null,
        };
      },
      async getGroupStats(_shopId, allowedGroups) {
        groupQueryCalled = true;
        assert.deepEqual(allowedGroups, [], "无发布 scope 时 allowedGroups 应为空");
        return [];
      },
      async getActiveScanJobId() {
        return null;
      },
    };

    const data = await getDashboardData("shop-fresh", dataAccess);

    assert.equal(groupQueryCalled, true, "空 scope 场景仍应走服务边界并返回空统计");
    assert.deepEqual(data.groups, [], "fresh shop 不应返回任何分组");
    assert.equal(data.lastPublishedAt, null, "fresh shop lastPublishedAt 应为 null");
    assert.equal(data.isScanning, false, "无 RUNNING scan_job 应返回 isScanning=false");
    assert.equal(data.activeScanJobId, null, "无 RUNNING scan_job 应返回 activeScanJobId=null");
  }

  console.log("✅ dashboard.service 单测全部通过");
}

run().catch((err: unknown) => {
  console.error("❌ dashboard.service 单测失败", err);
  process.exit(1);
});

