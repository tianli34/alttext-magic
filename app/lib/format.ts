/**
 * File: app/lib/format.ts
 * Purpose: 前端通用格式化工具函数。
 */

/** 相对时间阈值（毫秒） */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * 将 ISO 日期字符串格式化为中文相对时间。
 * 如 "3 小时前"、"2 天前"；超过一年则返回日期字符串。
 *
 * @param dateStr ISO 8601 日期字符串，null 时返回占位文本
 * @returns 格式化后的中文相对时间
 */
export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) {
    return "暂无数据";
  }

  const date = new Date(dateStr);
  const now = Date.now();
  const diff = now - date.getTime();

  // 未来时间（时钟偏移），直接返回日期
  if (diff < 0) {
    return formatDate(dateStr);
  }

  if (diff < MINUTE) {
    return "刚刚";
  }
  if (diff < HOUR) {
    return `${Math.floor(diff / MINUTE)} 分钟前`;
  }
  if (diff < DAY) {
    return `${Math.floor(diff / HOUR)} 小时前`;
  }
  if (diff < WEEK) {
    return `${Math.floor(diff / DAY)} 天前`;
  }
  if (diff < MONTH) {
    return `${Math.floor(diff / WEEK)} 周前`;
  }
  if (diff < YEAR) {
    return `${Math.floor(diff / MONTH)} 个月前`;
  }

  return formatDate(dateStr);
}

/**
 * 将 ISO 日期字符串格式化为可读日期。
 *
 * @param dateStr ISO 8601 日期字符串
 * @returns 格式化后的日期字符串（YYYY-MM-DD）
 */
export function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

/**
 * 将数字格式化为带千分位的字符串。
 *
 * @param value 数值
 * @returns 格式化后的字符串
 */
export function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}
