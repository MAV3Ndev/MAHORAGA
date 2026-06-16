import { type ReactNode } from 'react'
import clsx from 'clsx'

interface PanelProps {
  children: ReactNode
  title?: string
  titleRight?: string | ReactNode
  className?: string
  noPadding?: boolean
  variant?: 'default' | 'hero' | 'quiet'
}

export function Panel({
  children,
  title,
  titleRight,
  className,
  noPadding = false,
  variant = 'default',
}: PanelProps) {
  const hasBodyContent = children !== null && children !== undefined && children !== false

  return (
    <div
      className={clsx(
        'hud-panel flex min-h-0 min-w-0 flex-col',
        variant !== 'default' && `hud-panel--${variant}`,
        className,
      )}
    >
      {(title || titleRight) && (
        <div className="hud-panel-header flex min-w-0 justify-between items-center gap-3 border-b border-hud-line shrink-0 px-3 py-2.5">
          {title && <span className="hud-label">{title}</span>}
          {titleRight && (
            typeof titleRight === 'string' 
              ? <span className="hud-value-sm">{titleRight}</span>
              : titleRight
          )}
        </div>
      )}
      {hasBodyContent && (
        <div className={clsx('hud-panel-body flex-1 min-h-0 min-w-0', noPadding ? '' : 'p-3')}>
          {children}
        </div>
      )}
    </div>
  )
}
