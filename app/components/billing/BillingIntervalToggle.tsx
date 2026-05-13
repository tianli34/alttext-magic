/**
 * File: app/components/billing/BillingIntervalToggle.tsx
 * Purpose: 月付/年付切换按钮组。
 */
import type { BillingInterval } from './types';

interface BillingIntervalToggleProps {
  /** 当前选中的周期 */
  value: BillingInterval;
  /** 切换回调 */
  onChange: (interval: BillingInterval) => void;
  /** 是否禁用 */
  disabled?: boolean;
}

const INTERVAL_OPTIONS: { value: BillingInterval; label: string }[] = [
  { value: 'MONTHLY', label: '月付' },
  { value: 'ANNUAL', label: '年付' },
];

export function BillingIntervalToggle({
  value,
  onChange,
  disabled = false,
}: BillingIntervalToggleProps) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <s-stack direction="inline" gap="small">
        {INTERVAL_OPTIONS.map((option) => {
          const isActive = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.value)}
              style={{
                display: 'inline-block',
                padding: '0.5rem 1rem',
                border: isActive
                  ? 'none'
                  : '1px solid var(--p-color-border-secondary, #c9cccf)',
                borderRadius: '0.5rem',
                background: isActive
                  ? 'var(--p-color-bg-fill-brand, #008060)'
                  : 'var(--p-color-bg-surface, #ffffff)',
                color: isActive
                  ? 'var(--p-color-text-brand-on-bg-fill, #ffffff)'
                  : 'var(--p-color-text-primary, #202223)',
                font: 'inherit',
                fontWeight: isActive ? 600 : 400,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.6 : 1,
                transition: 'all 0.15s ease',
              }}
            >
              {option.label}
              {option.value === 'ANNUAL' && (
                <span
                  style={{
                    marginLeft: '6px',
                    fontSize: '0.75rem',
                    background: isActive
                      ? 'rgba(255,255,255,0.25)'
                      : 'var(--p-color-bg-fill-info, #dfe3e8)',
                    borderRadius: '4px',
                    padding: '2px 6px',
                    color: isActive
                      ? 'var(--p-color-text-brand-on-bg-fill, #ffffff)'
                      : 'var(--p-color-text-secondary, #6d7175)',
                  }}
                >
                  省30%
                </span>
              )}
            </button>
          );
        })}
      </s-stack>
    </div>
  );
}
