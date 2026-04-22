import { useEffect, type ReactNode } from 'react'
import { Panel } from './Panel'

interface DetailDialogProps {
  title: string
  titleRight?: ReactNode
  children: ReactNode
  onClose: () => void
}

export function DetailDialog({ title, titleRight, children, onClose }: DetailDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[10010] flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} className="w-full min-w-0 max-w-3xl">
        <Panel
          title={title}
          titleRight={
            titleRight ?? (
              <button onClick={onClose} className="hud-label hover:text-hud-primary">
                [ESC]
              </button>
            )
          }
          className="w-full max-h-[88vh] overflow-x-hidden overflow-y-auto"
        >
          <div className="min-w-0 space-y-5">
            {children}
          </div>
        </Panel>
      </div>
    </div>
  )
}
