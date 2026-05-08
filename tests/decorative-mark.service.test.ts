/**
 * File: tests/decorative-mark.service.test.ts
 * Purpose: 装饰性标记服务单测，覆盖状态联动、幂等、scope 与非法状态。
 */
import assert from "node:assert/strict";
import { AltCandidateStatus, CandidateGroupType } from "@prisma/client";
import {
  markDecorativeCandidate,
  unmarkDecorativeCandidate,
  type DecorativeMarkDataAccess,
} from "../server/modules/decorative/decorative-mark.server";
import { DecorativeActionError } from "../server/modules/decorative/decorative.types";
import type { ScanScopeFlags } from "../server/modules/shop/shop.types";

const allScopes: ScanScopeFlags = {
  PRODUCT_MEDIA: true,
  FILES: true,
  COLLECTION_IMAGE: true,
  ARTICLE_IMAGE: true,
};

const productOnlyScopes: ScanScopeFlags = {
  PRODUCT_MEDIA: true,
  FILES: false,
  COLLECTION_IMAGE: false,
  ARTICLE_IMAGE: false,
};

type TransactionArg = Parameters<
  Parameters<DecorativeMarkDataAccess["transaction"]>[0]
>[0];

interface MutableCandidate {
  id: string;
  altTargetId: string;
  status: AltCandidateStatus;
  currentAltEmpty: boolean;
  updatedAt: Date;
  decorativeActive: boolean;
  groupTypes: CandidateGroupType[];
}

interface Capture {
  upsertCount: number;
  deactivateCount: number;
  updateStatuses: AltCandidateStatus[];
}

function createCandidate(
  overrides: Partial<MutableCandidate> = {},
): MutableCandidate {
  return {
    id: "candidate-1",
    altTargetId: "target-1",
    status: AltCandidateStatus.MISSING,
    currentAltEmpty: true,
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    decorativeActive: false,
    groupTypes: [CandidateGroupType.PRODUCT_MEDIA],
    ...overrides,
  };
}

function cloneCandidate(candidate: MutableCandidate): MutableCandidate {
  return {
    ...candidate,
    groupTypes: [...candidate.groupTypes],
  };
}

function createDataAccess(
  candidate: MutableCandidate | null,
  capture: Capture,
  scopes: ScanScopeFlags = productOnlyScopes,
): DecorativeMarkDataAccess {
  const tx = {} as TransactionArg;

  return {
    async getShop() {
      return {
        scanScopeFlags: allScopes,
        lastPublishedScopeFlags: scopes,
      };
    },
    async transaction(callback) {
      return callback(tx);
    },
    async getCandidateForUpdate() {
      return candidate ? cloneCandidate(candidate) : null;
    },
    async upsertActiveMark() {
      capture.upsertCount += 1;
      if (candidate) {
        candidate.decorativeActive = true;
      }
    },
    async deactivateMark() {
      capture.deactivateCount += 1;
      if (candidate) {
        candidate.decorativeActive = false;
      }
    },
    async updateCandidateStatus(_tx, _input) {
      assert.ok(candidate, "候选存在时才能更新状态");
      candidate.status = _input.status;
      candidate.updatedAt = new Date(
        candidate.updatedAt.getTime() + capture.updateStatuses.length + 1,
      );
      capture.updateStatuses.push(_input.status);
      return cloneCandidate(candidate);
    },
  };
}

function createCapture(): Capture {
  return {
    upsertCount: 0,
    deactivateCount: 0,
    updateStatuses: [],
  };
}

async function run(): Promise<void> {
  {
    const candidate = createCandidate();
    const capture = createCapture();
    const data = await markDecorativeCandidate(
      "shop-1",
      candidate.id,
      createDataAccess(candidate, capture),
    );

    assert.equal(capture.upsertCount, 1, "mark 应 upsert active decorative_mark");
    assert.deepEqual(capture.updateStatuses, [
      AltCandidateStatus.DECORATIVE_SKIPPED,
    ]);
    assert.equal(data.status, AltCandidateStatus.DECORATIVE_SKIPPED);
    assert.equal(data.decorativeActive, true);
  }

  {
    const candidate = createCandidate({
      status: AltCandidateStatus.DECORATIVE_SKIPPED,
      decorativeActive: true,
    });
    const capture = createCapture();
    const data = await markDecorativeCandidate(
      "shop-1",
      candidate.id,
      createDataAccess(candidate, capture),
    );

    assert.equal(capture.upsertCount, 1, "重复 mark 仍保持 active 并成功返回");
    assert.deepEqual(capture.updateStatuses, [
      AltCandidateStatus.DECORATIVE_SKIPPED,
    ]);
    assert.equal(data.decorativeActive, true);
  }

  {
    const candidate = createCandidate({
      status: AltCandidateStatus.DECORATIVE_SKIPPED,
      decorativeActive: true,
    });
    const capture = createCapture();
    const data = await unmarkDecorativeCandidate(
      "shop-1",
      candidate.id,
      createDataAccess(candidate, capture),
    );

    assert.equal(capture.deactivateCount, 1, "unmark 应取消 active 标记");
    assert.deepEqual(capture.updateStatuses, [AltCandidateStatus.MISSING]);
    assert.equal(data.status, AltCandidateStatus.MISSING);
    assert.equal(data.decorativeActive, false);
  }

  {
    const candidate = createCandidate({
      status: AltCandidateStatus.MISSING,
      decorativeActive: false,
    });
    const capture = createCapture();
    const data = await unmarkDecorativeCandidate(
      "shop-1",
      candidate.id,
      createDataAccess(candidate, capture),
    );

    assert.equal(capture.deactivateCount, 1, "重复 unmark 不应报错");
    assert.deepEqual(capture.updateStatuses, [], "未激活标记时不应改写状态");
    assert.equal(data.status, AltCandidateStatus.MISSING);
  }

  {
    const candidate = createCandidate({
      status: AltCandidateStatus.DECORATIVE_SKIPPED,
      decorativeActive: true,
      currentAltEmpty: false,
    });
    const capture = createCapture();
    const data = await unmarkDecorativeCandidate(
      "shop-1",
      candidate.id,
      createDataAccess(candidate, capture),
    );

    assert.deepEqual(capture.updateStatuses, [AltCandidateStatus.RESOLVED]);
    assert.equal(data.status, AltCandidateStatus.RESOLVED);
  }

  {
    const candidate = createCandidate({
      groupTypes: [CandidateGroupType.FILES],
    });
    const capture = createCapture();

    await assert.rejects(
      markDecorativeCandidate(
        "shop-1",
        candidate.id,
        createDataAccess(candidate, capture),
      ),
      (err: unknown) =>
        err instanceof DecorativeActionError &&
        err.code === "OUT_OF_SCOPE" &&
        err.status === 403,
      "out-of-scope 候选应拒绝",
    );
    assert.equal(capture.upsertCount, 0, "越权请求不应写 decorative_mark");
    assert.deepEqual(capture.updateStatuses, []);
  }

  {
    const candidate = createCandidate({
      status: AltCandidateStatus.GENERATED,
    });
    const capture = createCapture();

    await assert.rejects(
      markDecorativeCandidate(
        "shop-1",
        candidate.id,
        createDataAccess(candidate, capture),
      ),
      (err: unknown) =>
        err instanceof DecorativeActionError &&
        err.code === "INVALID_STATUS" &&
        err.status === 409,
      "已生成候选应拒绝标记",
    );
    assert.equal(capture.upsertCount, 0, "非法状态不应写 decorative_mark");
    assert.deepEqual(capture.updateStatuses, []);
  }

  console.log("✅ decorative-mark.service 单测全部通过");
}

run().catch((err: unknown) => {
  console.error("❌ decorative-mark.service 单测失败", err);
  process.exit(1);
});
