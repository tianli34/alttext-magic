/**
 * File: app/hooks/useSidePanelRail.ts
 * Purpose: 保证左侧进度浮层停靠在仪表盘左侧留白中，且不与仪表盘内容重叠。
 *
 * 设计约束：仪表盘内容左边缘始终保持原位，不因浮层出现而位移；
 *           浮层按可用留白收敛宽度；任何情况下都保持左侧停靠，禁止退化为底部通栏。
 *
 * 为什么用「实测闭环」而不是解析式计算：
 *   s-page 的内部布局（padding / 居中 / max-width / 网格轨道）由 Shopify 组件控制，
 *   锚点容器的 rect.left 未必等于仪表盘内容的真实左边缘（内容可能溢出锚点框），
 *   按锚点估算会高估留白、导致浮层压到仪表盘上。因此：
 *   1) contentLeft 取「锚点与其直接子元素中最小的 left」，即真实可见内容的最左边缘；
 *   2) 挂载/尺寸变化后测量**浮层真实右边缘**，若仍与内容重叠则按重叠量继续收窄，
 *      直到不重叠（通常 1 次即收敛），有迭代上限与最小宽度兜底。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** 浮层首选宽度（px） */
export const SIDE_PANEL_WIDTH = 320;
/** 浮层可保留的最小宽度（px）：收窄到此下限仍重叠也维持左侧停靠，不再退化 */
export const SIDE_PANEL_MIN_WIDTH = 240;
/** 浮层距视口左边缘的内缩量（px）：需要把浮层再往左挪就调小这个值 */
export const SIDE_PANEL_EDGE_INSET = 12;
/** 浮层与仪表盘内容之间保留的最小间距（px） */
export const SIDE_PANEL_GAP = 1;

/** 单个可见周期内的最大收窄次数，防止极端布局下状态来回抖动 */
const MAX_CORRECTIONS = 6;

export interface SidePanelRail {
  /** 需绑定到仪表盘内容容器的 ref（用于测量内容真实左边缘） */
  anchorRef: RefObject<HTMLDivElement>;
  /** 需绑定到浮层元素的 ref（用于测量浮层真实右边缘） */
  panelRef: RefObject<HTMLDivElement>;
  /** 浮层实际宽度（px，已按可用留白收敛） */
  panelWidth: number;
}

/**
 * 测量仪表盘左侧留白并收敛浮层宽度，确保不与仪表盘内容重叠。
 *
 * @param active 浮层当前是否可见；变为 true 时会重新测量并校正一次。
 */
export function useSidePanelRail(active: boolean): SidePanelRail {
  const anchorRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelWidth, setPanelWidth] = useState(SIDE_PANEL_WIDTH);
  const correctionsRef = useRef(0);

  /**
   * 读取仪表盘内容的真实左边缘：取锚点与其直接子元素中最小的 left。
   * 内容溢出锚点框时（如 s-page 使用 min-content / 居中轨道）以更小的那个为准，
   * 宁可高估占用、也不低估导致重叠。
   */
  const readContentLeft = useCallback((): number | null => {
    const anchor = anchorRef.current;
    if (!anchor) {
      return null;
    }
    let left = anchor.getBoundingClientRect().left;
    for (const child of Array.from(anchor.children)) {
      left = Math.min(left, child.getBoundingClientRect().left);
    }
    return left;
  }, []);

  /** 视口尺寸变化：重新从首选宽度开始校正 */
  const handleViewportChange = useCallback(() => {
    correctionsRef.current = 0;
    setPanelWidth(SIDE_PANEL_WIDTH);
  }, []);

  useEffect(() => {
    window.addEventListener("resize", handleViewportChange);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => handleViewportChange());
    if (observer) {
      observer.observe(document.documentElement);
      if (anchorRef.current) {
        observer.observe(anchorRef.current);
      }
    }
    return () => {
      window.removeEventListener("resize", handleViewportChange);
      observer?.disconnect();
    };
  }, [handleViewportChange]);

  // 闭环校正：在 rAF 中测量（布局已稳定），重叠则按重叠量收窄浮层
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (!active) {
        if (panelWidth !== SIDE_PANEL_WIDTH) {
          setPanelWidth(SIDE_PANEL_WIDTH);
        }
        return;
      }

      const contentLeft = readContentLeft();
      if (contentLeft === null) {
        return;
      }

      const panel = panelRef.current;
      // 优先使用浮层的真实右边缘（含 CSS 影响），未挂载时按常量估算
      const panelRight = panel
        ? panel.getBoundingClientRect().right
        : SIDE_PANEL_EDGE_INSET + panelWidth;
      const overlap = Math.round(panelRight + SIDE_PANEL_GAP - contentLeft);

      if (import.meta.env.DEV) {
        console.debug("[sidePanelRail]", {
          contentLeft: Math.round(contentLeft),
          panelRight: Math.round(panelRight),
          panelWidth,
          overlap,
        });
      }

      if (overlap <= 0) {
        return; // 已无重叠，收敛
      }

      if (correctionsRef.current >= MAX_CORRECTIONS) {
        return; // 到达迭代上限，维持当前宽度（禁止切换为底部停靠）
      }
      correctionsRef.current += 1;

      // 收窄但不低于可读下限；极端窄视口下宁可保持左侧停靠
      const next = Math.max(panelWidth - overlap, SIDE_PANEL_MIN_WIDTH);
      if (next === panelWidth) {
        return;
      }
      setPanelWidth(next);
    });

    return () => cancelAnimationFrame(raf);
  }, [active, panelWidth, readContentLeft]);

  return { anchorRef, panelRef, panelWidth };
}
