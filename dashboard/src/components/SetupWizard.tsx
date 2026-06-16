import { useState, type ReactNode } from 'react'
import type { ConnectionSettings } from '../lib/connection'
import { getDefaultApiUrl, isNativeShell, normalizeApiUrl } from '../lib/connection'
import { Panel } from './Panel'

interface SetupWizardProps {
  initialConnection: ConnectionSettings
  onComplete: (connection: ConnectionSettings) => Promise<void>
  updateControls?: ReactNode
}

export function SetupWizard({ initialConnection, onComplete, updateControls }: SetupWizardProps) {
  const [apiUrl, setApiUrl] = useState(initialConnection.apiUrl || getDefaultApiUrl())
  const [bearerToken, setBearerToken] = useState(initialConnection.bearerToken || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nativeShell = isNativeShell()

  const handleSubmit = async () => {
    let normalizedUrl = ''
    try {
      normalizedUrl = normalizeApiUrl(apiUrl)
    } catch {
      setError('API URL is invalid')
      return
    }

    const trimmedToken = bearerToken.trim()

    if (!normalizedUrl) {
      setError('API URL is required')
      return
    }

    if (!trimmedToken) {
      setError('Bearer token is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      await onComplete({
        apiUrl: normalizedUrl,
        bearerToken: trimmedToken,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to MAHORAGA-Next')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-hud-bg flex items-center justify-center p-6">
      <div className="w-full max-w-5xl grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <Panel title="MAHORAGA-Next PANEL" className="relative overflow-hidden">
          <div className="absolute inset-0 opacity-40 pointer-events-none bg-[radial-gradient(circle_at_top_left,rgba(90,154,184,0.18),transparent_45%),radial-gradient(circle_at_bottom_right,rgba(138,106,184,0.14),transparent_40%)]" />
          <div className="relative space-y-6 min-h-[420px] flex flex-col justify-between">
            <div className="space-y-5">
              <div>
                <div className="hud-label text-hud-primary mb-2">
                  {nativeShell ? 'ANDROID CONTROL SURFACE' : 'DESKTOP CONTROL SURFACE'}
                </div>
                <h1 className="text-4xl sm:text-5xl font-bold tracking-[0.14em] text-hud-text-bright m-0">
                  MAHORAGA-Next PANEL
                </h1>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="border border-hud-line bg-hud-bg/70 p-3">
                  <div className="hud-label text-hud-cyan mb-2">STATUS</div>
                  <div className="hud-value-md">Agent heartbeat</div>
                  <div className="text-xs text-hud-text-dim mt-2">enabled / disabled / market clock / live logs</div>
                </div>
                <div className="border border-hud-line bg-hud-bg/70 p-3">
                  <div className="hud-label text-hud-success mb-2">BALANCE</div>
                  <div className="hud-value-md">Equity telemetry</div>
                  <div className="text-xs text-hud-text-dim mt-2">portfolio history / realized / unrealized / cost trace</div>
                </div>
                <div className="border border-hud-line bg-hud-bg/70 p-3">
                  <div className="hud-label text-hud-purple mb-2">CONTROL</div>
                  <div className="hud-value-md">Remote config</div>
                  <div className="text-xs text-hud-text-dim mt-2">thresholds / options / crypto / model settings</div>
                </div>
              </div>
            </div>
          </div>
        </Panel>

        <Panel title="REMOTE LINK" className="justify-center">
          <div className="space-y-5">
            <div>
              <div className="hud-label mb-2 text-hud-primary">API URL</div>
              <input
                type="text"
                className="hud-input w-full"
                placeholder={nativeShell ? 'https://your-mahoraga-next.workers.dev' : 'https://your-mahoraga-next.workers.dev'}
                value={apiUrl}
                onChange={(event) => setApiUrl(event.target.value)}
              />
              <p className="text-xs text-hud-text-dim mt-2">
                {nativeShell ? '例: `https://your-app.workers.dev`' : '例: `https://your-app.workers.dev`'}
              </p>
            </div>

            <div>
              <div className="hud-label mb-2 text-hud-primary">Bearer Token</div>
              <input
                type="password"
                className="hud-input w-full"
                placeholder="MAHORAGA_API_TOKEN"
                value={bearerToken}
                onChange={(event) => setBearerToken(event.target.value)}
              />
            </div>

            {error && (
              <div className="border border-hud-error/40 bg-hud-error/10 px-3 py-2 text-sm text-hud-error">
                {error}
              </div>
            )}

            <button type="button" className="hud-button w-full" onClick={handleSubmit} disabled={saving}>
              {saving ? 'LINKING...' : 'CONNECT PANEL'}
            </button>

            {updateControls}
          </div>
        </Panel>
      </div>
    </div>
  )
}
