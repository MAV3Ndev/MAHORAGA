import type { ReactNode } from 'react'
import clsx from 'clsx'

interface StatusIndicatorProps {
  status: 'active' | 'warning' | 'error' | 'inactive'
  label?: string
  pulse?: boolean
  className?: string
}

const statusColors = {
  active: 'bg-hud-success',
  warning: 'bg-hud-warning',
  error: 'bg-hud-error',
  inactive: 'bg-hud-dim',
}

export function StatusIndicator({
  status,
  label,
  pulse = false,
  className,
}: StatusIndicatorProps) {
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className="relative">
        <div
          className={clsx(
            'w-2 h-2 rounded-full',
            statusColors[status]
          )}
        />
        {pulse && status === 'active' && (
          <div
            className={clsx(
              'absolute inset-0 w-2 h-2 rounded-full animate-ping',
              statusColors[status],
              'opacity-75'
            )}
          />
        )}
      </div>
      {label && <span className="hud-label">{label}</span>}
    </div>
  )
}

interface StatusBarProps {
  items: Array<{
    label: string
    value: ReactNode
    status?: 'active' | 'warning' | 'error' | 'inactive'
    multiline?: boolean
  }>
  className?: string
}

export function StatusBar({
  items,
  className,
}: StatusBarProps) {
  return (
    <div className={clsx('flex flex-wrap items-center gap-3 sm:gap-6', className)}>
      {items.map((item, i) => (
        <div key={i} className={clsx('hud-statusbar-item', item.multiline && 'hud-statusbar-item-multiline')}>
          {item.status && (
            <div
              className={clsx('hud-statusbar-dot', statusColors[item.status], item.multiline && 'hud-statusbar-dot-multiline')}
            />
          )}
          <span className={clsx('hud-label hud-statusbar-label', item.multiline && 'hud-statusbar-label-multiline')}>{item.label}</span>
          <span className={clsx('hud-value-sm hud-statusbar-value', item.multiline && 'hud-statusbar-value-multiline')}>{item.value}</span>
        </div>
      ))}
    </div>
  )
}
