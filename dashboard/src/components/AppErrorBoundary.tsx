import { Component, type ErrorInfo, type ReactNode } from 'react'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  error: Error | null
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Sentinel UI crashed', error, errorInfo)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <div className="min-h-screen bg-hud-bg p-6 text-hud-text">
        <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-md items-center">
          <div className="hud-panel w-full p-5">
            <div className="hud-label mb-3 text-hud-error">UI FAULT</div>
            <h1 className="m-0 text-2xl font-semibold text-hud-text-bright">SENTINEL could not start</h1>
            <p className="mt-3 text-sm leading-6 text-hud-text-dim">
              The Android control surface hit a startup error instead of rendering the dashboard.
            </p>
            <pre className="mt-4 max-h-40 overflow-auto rounded-lg border border-hud-line bg-hud-bg p-3 text-xs text-hud-error">
              {this.state.error.message}
            </pre>
            <button className="hud-button mt-5 w-full" onClick={() => window.location.reload()}>
              RELOAD
            </button>
          </div>
        </div>
      </div>
    )
  }
}
