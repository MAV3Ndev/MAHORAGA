export interface ConnectionSettings {
  apiUrl: string
  bearerToken: string
}

interface CapacitorBridge {
  isNativePlatform?: () => boolean
}

export interface DesktopLifecycleEvent {
  type: string
  timestamp?: number
}

interface DesktopBridge {
  loadConnectionSettings: () => Promise<ConnectionSettings | null>
  saveConnectionSettings: (settings: ConnectionSettings) => Promise<ConnectionSettings>
  request: (input: { path: string; method?: string; body?: unknown; connection?: ConnectionSettings }) => Promise<{
    ok: boolean
    status: number
    data: unknown
  }>
  openExternal: (url: string) => Promise<void>
  notify: (payload: { title: string; body: string }) => Promise<boolean>
  onLifecycleEvent: (listener: (event: DesktopLifecycleEvent) => void) => () => void
}

declare global {
  interface Window {
    Capacitor?: CapacitorBridge
    mahoragaDesktop?: DesktopBridge
  }
}

const API_URL_KEY = 'mahoraga_connection_url'
const TOKEN_KEY = 'mahoraga_api_token'

export function isDesktopPanel(): boolean {
  return typeof window !== 'undefined' && Boolean(window.mahoragaDesktop)
}

export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false
  if (isDesktopPanel()) return false
  if (window.Capacitor?.isNativePlatform?.()) return true
  return window.location.protocol === 'capacitor:'
}

export function getDefaultApiUrl(): string {
  if (typeof window === 'undefined') return ''
  if (isNativeShell()) return ''
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787'
  }
  return window.location.origin
}

export function normalizeApiUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''

  const hasProtocol = /^[a-zA-Z]+:\/\//.test(trimmed)
  const protocol = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)/.test(trimmed) ? 'http://' : 'https://'
  const url = new URL(hasProtocol ? trimmed : `${protocol}${trimmed}`)
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/agent$/, '')
  return url.toString().replace(/\/$/, '')
}

function sanitizeConnection(settings: Partial<ConnectionSettings> | null | undefined): ConnectionSettings {
  return {
    apiUrl: normalizeApiUrl(settings?.apiUrl || getDefaultApiUrl()),
    bearerToken: (settings?.bearerToken || '').trim(),
  }
}

export async function loadConnectionSettings(): Promise<ConnectionSettings> {
  if (isDesktopPanel()) {
    const saved = await window.mahoragaDesktop?.loadConnectionSettings()
    return sanitizeConnection(saved)
  }

  return sanitizeConnection({
    apiUrl: localStorage.getItem(API_URL_KEY) || getDefaultApiUrl(),
    bearerToken: localStorage.getItem(TOKEN_KEY) || '',
  })
}

export async function saveConnectionSettings(settings: ConnectionSettings): Promise<ConnectionSettings> {
  const sanitized = sanitizeConnection(settings)

  if (isDesktopPanel()) {
    const saved = await window.mahoragaDesktop?.saveConnectionSettings(sanitized)
    return sanitizeConnection(saved)
  }

  localStorage.setItem(API_URL_KEY, sanitized.apiUrl)
  localStorage.setItem(TOKEN_KEY, sanitized.bearerToken)
  return sanitized
}

function buildAgentUrl(baseUrl: string, agentPath: string): string {
  const root = new URL(normalizeApiUrl(baseUrl))
  const requested = new URL(agentPath.startsWith('/') ? agentPath : `/${agentPath}`, 'http://mahoraga.local')
  const basePath = root.pathname.replace(/\/$/, '')
  root.pathname = `${basePath}/agent${requested.pathname}`.replace(/\/{2,}/g, '/')
  root.search = requested.search
  return root.toString()
}

export function maskBearerToken(token: string): string {
  if (!token) return 'UNSET'
  if (token.length <= 10) return `${token.slice(0, 2)}***${token.slice(-2)}`
  return `${token.slice(0, 6)}...${token.slice(-4)}`
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function requestAgent<T = unknown>(
  path: string,
  options: {
    method?: string
    body?: unknown
    connection?: ConnectionSettings
  } = {},
): Promise<{ ok: boolean; status: number; data: T }> {
  const connection = sanitizeConnection(options.connection || (await loadConnectionSettings()))

  if (!connection.apiUrl || !connection.bearerToken) {
    throw new Error('Connection is not configured. Set API URL and Bearer token first.')
  }

  if (isDesktopPanel()) {
    const response = await window.mahoragaDesktop?.request({
      path,
      method: options.method,
      body: options.body,
      connection,
    })

    if (!response) {
      throw new Error('Desktop bridge is unavailable.')
    }

    return response as { ok: boolean; status: number; data: T }
  }

  const headers = new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${connection.bearerToken}`,
  })

  let body: string | undefined
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(options.body)
  }

  const response = await fetch(buildAgentUrl(connection.apiUrl, path), {
    method: options.method || 'GET',
    headers,
    body,
  })

  const text = await response.text()
  return {
    ok: response.ok,
    status: response.status,
    data: parseJson(text) as T,
  }
}

export function getResponseError(data: unknown, fallback: string): string {
  if (typeof data === 'string' && data.trim()) return data
  if (typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string') {
    return data.error
  }
  return fallback
}

export async function showDesktopNotification(title: string, body: string): Promise<boolean> {
  if (!isDesktopPanel()) return false
  return (await window.mahoragaDesktop?.notify({ title, body })) ?? false
}

export function subscribeDesktopLifecycle(
  listener: (event: DesktopLifecycleEvent) => void,
): (() => void) | undefined {
  return window.mahoragaDesktop?.onLifecycleEvent(listener)
}
