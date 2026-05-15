/**
 * File: server/shopify/shopify-rate-limiter.server.ts
 * Purpose: Shopify Admin GraphQL 令牌桶限流器（Token Bucket）。
 *
 * 设计要点:
 * - 单店铺维度隔离，每个 shopId 持有独立桶实例
 * - 消耗代价成本（cost）匹配 Shopify GraphQL Cost Extension
 * - 扫描扫描与生成管线共用同一限流器实例（进程内单例）
 * - acquire(cost) 返回 Promise，等待桶内有足够令牌后 resolve
 */

import { createLogger } from "../utils/logger";

const logger = createLogger({ module: "shopify-rate-limiter" });

/** 令牌桶配置 */
export interface TokenBucketOptions {
  /** 桶最大容量（令牌数），Shopify 默认 1000 */
  capacity: number;
  /** 每秒恢复令牌数，Shopify 默认 50 */
  refillRate: number;
}

const DEFAULT_OPTIONS: TokenBucketOptions = {
  capacity: 1000,
  refillRate: 50,
};

/** 单个令牌桶实例 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number; // ms timestamp
  private readonly capacity: number;
  private readonly refillRate: number; // tokens/second

  constructor(options: TokenBucketOptions = DEFAULT_OPTIONS) {
    this.capacity = options.capacity;
    this.refillRate = options.refillRate;
    this.tokens = options.capacity;
    this.lastRefill = Date.now();
  }

  /** 补充令牌（基于经过时间） */
  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000; // 秒
    const added = elapsed * this.refillRate;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = now;
  }

  /**
   * 申请 cost 个令牌，令牌不足时等待至可用。
   * @param cost 所需令牌数（Shopify 查询默认 cost=1）
   */
  async acquire(cost = 1): Promise<void> {
    while (true) {
      this.refill();

      if (this.tokens >= cost) {
        this.tokens -= cost;
        return;
      }

      // 计算等待时间（毫秒），加 10ms 缓冲
      const deficit = cost - this.tokens;
      const waitMs = Math.ceil((deficit / this.refillRate) * 1000) + 10;
      logger.debug({ cost, tokens: this.tokens, waitMs }, "rate-limiter.waiting");
      await sleep(waitMs);
    }
  }

  /** 当前剩余令牌数（供外部监控） */
  get available(): number {
    this.refill();
    return this.tokens;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 进程内按 shopId 隔离的限流器注册表 */
const registry = new Map<string, TokenBucket>();

/**
 * 获取（或创建）指定店铺的令牌桶。
 * 扫描管线与生成管线传入相同 shopId 即可共用同一桶实例。
 */
export function getShopifyRateLimiter(
  shopId: string,
  options: TokenBucketOptions = DEFAULT_OPTIONS,
): TokenBucket {
  let bucket = registry.get(shopId);

  if (!bucket) {
    bucket = new TokenBucket(options);
    registry.set(shopId, bucket);
  }

  return bucket;
}

/** 仅供测试：清空注册表 */
export function _clearRateLimiterRegistryForTests(): void {
  registry.clear();
}
