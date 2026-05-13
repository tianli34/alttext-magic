/**
 * File: app/components/billing/OveragePackCard.tsx
 * Purpose: 超额包购买卡片组件。
 */
import type { OveragePackSummary } from './types';

interface OveragePackCardProps {
  /** 可用的超额包列表 */
  packs: OveragePackSummary[];
  /** 购买回调 */
  onPurchase: (packCode: string) => void;
  /** 按钮禁用（请求中） */
  disabled?: boolean;
}

export function OveragePackCard({
  packs,
  onPurchase,
  disabled = false,
}: OveragePackCardProps) {
  if (packs.length === 0) {
    return (
      <s-box
        padding="base"
        borderRadius="base"
        borderWidth="base"
        background="subdued"
      >
        <s-text tone="neutral">当前计划暂无可用超额包。</s-text>
      </s-box>
    );
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
        gap: '16px',
      }}
    >
      {packs.map((pack) => (
        <div
          key={pack.packCode}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            border: '1px solid var(--p-color-border-secondary, #c9cccf)',
            borderRadius: '0.75rem',
            padding: '16px',
          }}
        >
          {/* 额度数 */}
          <s-stack direction="block" gap="small">
            <s-heading>{pack.credits} 次</s-heading>
            <s-text tone="neutral">超额包</s-text>
          </s-stack>

          {/* 价格 */}
          <span style={{ fontSize: '1.25rem', fontWeight: 600 }}>
            {pack.displayPrice}
          </span>

          {/* 购买按钮 */}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onPurchase(pack.packCode)}
            style={{
              display: 'block',
              width: '100%',
              padding: '0.5rem 1rem',
              border: '1px solid var(--p-color-border-brand, #008060)',
              borderRadius: '0.5rem',
              background: 'transparent',
              color: 'var(--p-color-text-brand, #008060)',
              font: 'inherit',
              fontWeight: 600,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            购买
          </button>
        </div>
      ))}
    </div>
  );
}
