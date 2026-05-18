/**
 * File: app/hooks/useInfiniteScroll.ts
 * Purpose: 基于 IntersectionObserver 的无限滚动 Hook。
 *          当目标元素进入视口时触发回调，用于实现瀑布流加载。
 */
import { useEffect, useRef } from "react";

interface UseInfiniteScrollOptions {
  /** 是否还有更多数据可加载 */
  hasMore: boolean;
  /** 是否正在加载中 */
  loading: boolean;
  /** 触底回调 */
  onLoadMore: () => void;
  /** IntersectionObserver 阈值（默认 0） */
  threshold?: number;
  /** IntersectionObserver rootMargin（默认 "200px" —— 提前触发） */
  rootMargin?: string;
}

/**
 * 返回一个 ref，挂载到用于观测的哨兵元素上。
 * 当哨兵进入视口且 hasMore && !loading 时自动调用 onLoadMore。
 */
export function useInfiniteScroll({
  hasMore,
  loading,
  onLoadMore,
  threshold = 0,
  rootMargin = "200px",
}: UseInfiniteScrollOptions) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    if (!hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onLoadMore();
          }
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loading, onLoadMore, threshold, rootMargin]);

  return sentinelRef;
}
