/**
 * File: app/hooks/useInfiniteScroll.ts
 * Purpose: 基于 IntersectionObserver 的无限滚动 Hook。
 *          当目标元素进入视口时触发回调，用于实现瀑布流加载。
 */
import { useEffect, useRef, useState } from "react";

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
 * 返回一个回调 ref，挂载到用于观测的哨兵元素上。
 * 当哨兵进入视口且 hasMore && !loading 时自动调用 onLoadMore。
 *
 * 使用回调 ref（而非普通 ref）保证：每当哨兵 DOM 节点挂载/卸载时，
 * 观测器都会随 effect 重新建立。若不追踪节点本身，切换 scope/状态导致
 * 列表重渲染、nextCursor 恰好返回相同值时，effect 的依赖不变，新节点
 * 永远不会被观测，从而滚动到底部不再触发加载。
 */
export function useInfiniteScroll({
  hasMore,
  loading,
  onLoadMore,
  threshold = 0,
  rootMargin = "200px",
}: UseInfiniteScrollOptions) {
  // 用 ref 保存最新回调，避免 onLoadMore 身份变化（如依赖 nextCursor）时
  // 频繁断开/重建观测器。
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  // 哨兵节点本身作为状态依赖：节点挂载/卸载会触发 effect 重新建立观测。
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sentinel) return;
    if (!hasMore || loading) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onLoadMoreRef.current();
          }
        }
      },
      { threshold, rootMargin },
    );

    observer.observe(sentinel);

    return () => {
      observer.disconnect();
    };
  }, [sentinel, hasMore, loading, threshold, rootMargin]);

  return setSentinel;
}
