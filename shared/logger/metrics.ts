// shared/logger/metrics.ts
/**
 * 关键指标埋点工具
 *
 * 提供 recordMetric(name, value, tags) 函数，
 * 本质上是 logger.info({ metric: name, value, ...tags })，
 * 便于后续接入 Grafana / Loki 等可观测性平台做结构化指标查询。
 */
import { createLogger } from "./index";

const metricLogger = createLogger("metrics");

/**
 * 指标标签类型（键值对，值为 string | number | boolean）
 */
export type MetricTags = Record<string, string | number | boolean>;

/**
 * 记录一条指标日志
 *
 * @param name  指标名称，如 "scan.rows_total"、"generate.success"
 * @param value 指标值（数字）
 * @param tags  附加标签，如 { shop_domain, batch_id, error_code }
 */
export function recordMetric(
  name: string,
  value: number,
  tags: MetricTags = {},
): void {
  metricLogger.info(
    {
      metric: name,
      value,
      ...tags,
    },
    `metric:${name}`,
  );
}
