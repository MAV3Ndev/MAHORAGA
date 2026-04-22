import { useEffect, useState } from 'react'
import type { Config } from '../types'
import { Panel } from './Panel'
import type { ConnectionSettings } from '../lib/connection'
import { normalizeApiUrl } from '../lib/connection'

const RESEARCH_MODEL_PRESETS: Record<string, string[]> = {
  'openai-raw': ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o'],
  'ai-sdk': [
    'openai/gpt-4o-mini',
    'openai/gpt-4.1-mini',
    'anthropic/claude-3-5-haiku-latest',
    'google/gemini-2.5-flash',
    'deepseek/deepseek-chat',
  ],
  'cloudflare-gateway': [
    'openai/gpt-4o-mini',
    'openai/gpt-5-mini',
    'anthropic/claude-haiku-4-5',
    'google-ai-studio/gemini-2.5-flash',
  ],
}

const ANALYST_MODEL_PRESETS: Record<string, string[]> = {
  'openai-raw': ['gpt-5.2-2025-12-11', 'gpt-4.1', 'gpt-4o'],
  'ai-sdk': [
    'openai/gpt-4o',
    'openai/o1',
    'anthropic/claude-sonnet-4-0',
    'google/gemini-2.5-pro',
    'xai/grok-4',
    'deepseek/deepseek-reasoner',
  ],
  'cloudflare-gateway': [
    'openai/gpt-5.2',
    'openai/gpt-5',
    'anthropic/claude-opus-4-5',
    'google-ai-studio/gemini-2.5-pro',
  ],
}

interface SettingsModalProps {
  config: Config
  connection: ConnectionSettings
  onSave: (config: Config) => Promise<void> | void
  onSaveConnection: (connection: ConnectionSettings) => Promise<void> | void
  onClose: () => void
}

type SettingsTab = 'strategy' | 'risk' | 'assets' | 'ai' | 'system'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'strategy', label: 'Strategy' },
  { id: 'risk', label: 'Risk' },
  { id: 'assets', label: 'Assets' },
  { id: 'ai', label: 'AI' },
  { id: 'system', label: 'System' },
]

export function SettingsModal({ config, connection, onSave, onSaveConnection, onClose }: SettingsModalProps) {
  const [localConfig, setLocalConfig] = useState<Config>(() => ({
    ...config,
    llm_provider: (config.llm_provider as string | undefined) === 'openai-compatible' ? 'openai-raw' : config.llm_provider,
  }))
  const [activeTab, setActiveTab] = useState<SettingsTab>('strategy')
  const [saving, setSaving] = useState(false)
  const [connectionSaving, setConnectionSaving] = useState(false)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [apiUrl, setApiUrl] = useState(connection.apiUrl)
  const [apiToken, setApiToken] = useState(connection.bearerToken)
  const llmProvider = ((localConfig.llm_provider as string | undefined) === 'openai-compatible'
    ? 'openai-raw'
    : localConfig.llm_provider) || 'openai-raw'
  const researchModelSuggestions = RESEARCH_MODEL_PRESETS[llmProvider] || []
  const analystModelSuggestions = ANALYST_MODEL_PRESETS[llmProvider] || []
  const showOpenAIBaseUrl = ['openai-raw', 'ai-sdk'].includes(llmProvider)

  // Note: We intentionally do NOT sync localConfig with the config prop after initial mount.
  // This prevents the parent's polling (every 5s) from overwriting user's unsaved changes.

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleConnectionSave = async () => {
    const normalizedUrl = normalizeApiUrl(apiUrl)
    const trimmedToken = apiToken.trim()

    if (!normalizedUrl) {
      setConnectionError('API URL is required')
      return
    }

    if (!trimmedToken) {
      setConnectionError('Bearer token is required')
      return
    }

    setConnectionSaving(true)
    setConnectionError(null)

    try {
      await onSaveConnection({
        apiUrl: normalizedUrl,
        bearerToken: trimmedToken,
      })
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Failed to update remote link')
    } finally {
      setConnectionSaving(false)
    }
  }

  const handleChange = <K extends keyof Config>(key: K, value: Config[K]) => {
    setLocalConfig(prev => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave({
        ...localConfig,
        llm_provider: (localConfig.llm_provider as string | undefined) === 'openai-compatible'
          ? 'openai-raw'
          : localConfig.llm_provider,
      })
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const tabButtonClass = (tab: SettingsTab) =>
    activeTab === tab
      ? 'hud-button h-8 min-h-0 rounded-lg px-3 py-1.5 text-[10px] tracking-[0.12em]'
      : 'hud-button hud-button-muted h-8 min-h-0 rounded-lg px-3 py-1.5 text-[10px] tracking-[0.12em]'

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <Panel
        title="TRADING CONFIGURATION"
        className="w-full max-w-4xl max-h-[90vh] overflow-auto"
        titleRight={
          <button onClick={onClose} className="hud-label hover:text-hud-primary">
            [ESC]
          </button>
        }
      >
        <div onClick={e => e.stopPropagation()} className="space-y-6">
          <div className="border-b border-hud-line pb-4">
            <div className="flex flex-wrap gap-2">
              {SETTINGS_TABS.map(tab => (
                <button key={tab.id} className={tabButtonClass(tab.id)} onClick={() => setActiveTab(tab.id)}>
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'strategy' && (
            <div className="space-y-6">
              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Position Limits</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Max Position Value ($)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.max_position_value}
                      onChange={e => handleChange('max_position_value', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Positions</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.max_positions}
                      onChange={e => handleChange('max_positions', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Position Size (% of Cash)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.position_size_pct_of_cash}
                      onChange={e => handleChange('position_size_pct_of_cash', Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Research Breadth</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Signal Research Limit</label>
                    <input
                      type="number"
                      min="1"
                      max="20"
                      className="hud-input w-full"
                      value={localConfig.signal_research_limit}
                      onChange={e => handleChange('signal_research_limit', Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      1サイクルでLLM調査に回すシグナル数。増やすほど取りこぼしは減るが、コストとノイズは増えます。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Entry Candidate Limit</label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      className="hud-input w-full"
                      value={localConfig.entry_candidate_limit}
                      onChange={e => handleChange('entry_candidate_limit', Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      実際にエントリー判定まで進める上位候補数。増やすほどアグレッシブになります。
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Sentiment Thresholds</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Min Sentiment to Buy (0-1)</label>
                    <input
                      type="number"
                      step="0.05"
                      className="hud-input w-full"
                      value={localConfig.min_sentiment_score}
                      onChange={e => handleChange('min_sentiment_score', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Min Analyst Confidence (0-1)</label>
                    <input
                      type="number"
                      step="0.05"
                      className="hud-input w-full"
                      value={localConfig.min_analyst_confidence}
                      onChange={e => handleChange('min_analyst_confidence', Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Entry Timing</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.entry_timing_enabled ?? true}
                        onChange={e => handleChange('entry_timing_enabled', e.target.checked)}
                      />
                      <span className="hud-label">Enable Entry Timing Filter</span>
                    </label>
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      RSI とボリンジャーバンド下限近接度で、飛びつき買いを抑えるフィルターです。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Entry RSI Min</label>
                    <input
                      type="number"
                      step="1"
                      className="hud-input w-full"
                      value={localConfig.entry_rsi_min ?? 40}
                      onChange={e => handleChange('entry_rsi_min', Number(e.target.value))}
                      disabled={!(localConfig.entry_timing_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Entry RSI Max</label>
                    <input
                      type="number"
                      step="1"
                      className="hud-input w-full"
                      value={localConfig.entry_rsi_max ?? 55}
                      onChange={e => handleChange('entry_rsi_max', Number(e.target.value))}
                      disabled={!(localConfig.entry_timing_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">BB Lower Threshold</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.entry_bb_lower_threshold ?? 0.2}
                      onChange={e => handleChange('entry_bb_lower_threshold', Number(e.target.value))}
                      disabled={!(localConfig.entry_timing_enabled ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      小さいほど押し目寄り、大きいほど広く許容します。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'risk' && (
            <div className="space-y-6">
              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Risk Management</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Take Profit (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.take_profit_pct}
                      onChange={e => handleChange('take_profit_pct', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Stop Loss (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.stop_loss_pct}
                      onChange={e => handleChange('stop_loss_pct', Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Market Regime</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.market_regime_enabled ?? true}
                        onChange={e => handleChange('market_regime_enabled', e.target.checked)}
                      />
                      <span className="hud-label">Enable Market Regime Sizing</span>
                    </label>
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      地合いが弱いときにポジションサイズを圧縮する仕組みです。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Low Regime Threshold</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.regime_low_threshold ?? 0.5}
                      onChange={e => handleChange('regime_low_threshold', Number(e.target.value))}
                      disabled={!(localConfig.market_regime_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Size Reduction Factor</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.regime_position_size_reduction ?? 0.45}
                      onChange={e => handleChange('regime_position_size_reduction', Number(e.target.value))}
                      disabled={!(localConfig.market_regime_enabled ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      0.75 なら弱地合いでも通常サイズの 75% を維持します。
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Portfolio Risk</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.portfolio_risk_enabled ?? true}
                        onChange={e => handleChange('portfolio_risk_enabled', e.target.checked)}
                      />
                      <span className="hud-label">Enable Sector Exposure Guard</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Positions Per Sector</label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      className="hud-input w-full"
                      value={localConfig.max_positions_per_sector ?? 2}
                      onChange={e => handleChange('max_positions_per_sector', Number(e.target.value))}
                      disabled={!(localConfig.portfolio_risk_enabled ?? true)}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-warning">Stale Position Management</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.stale_position_enabled ?? true}
                        onChange={e => handleChange('stale_position_enabled', e.target.checked)}
                      />
                      <span className="hud-label">Enable Stale Position Detection</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Hold Days</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.stale_max_hold_days || 3}
                      onChange={e => handleChange('stale_max_hold_days', Number(e.target.value))}
                      disabled={!localConfig.stale_position_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Min Gain % to Keep</label>
                    <input
                      type="number"
                      step="0.5"
                      className="hud-input w-full"
                      value={localConfig.stale_min_gain_pct || 5}
                      onChange={e => handleChange('stale_min_gain_pct', Number(e.target.value))}
                      disabled={!localConfig.stale_position_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Social Volume Decay</label>
                    <input
                      type="number"
                      step="0.1"
                      className="hud-input w-full"
                      value={localConfig.stale_social_volume_decay || 0.3}
                      onChange={e => handleChange('stale_social_volume_decay', Number(e.target.value))}
                      disabled={!localConfig.stale_position_enabled}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">Exit if volume drops to this % of entry</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'assets' && (
            <div className="space-y-6">
              <div>
                <h3 className="hud-label mb-3 text-hud-purple">Options Trading (Beta)</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.options_enabled || false}
                        onChange={e => handleChange('options_enabled', e.target.checked)}
                      />
                      <span className="hud-label">Enable Options Trading</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Min Confidence (0-1)</label>
                    <input
                      type="number"
                      step="0.05"
                      className="hud-input w-full"
                      value={localConfig.options_min_confidence || 0.75}
                      onChange={e => handleChange('options_min_confidence', Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max % Per Trade</label>
                    <input
                      type="number"
                      step="0.5"
                      className="hud-input w-full"
                      value={localConfig.options_max_pct_per_trade || 2}
                      onChange={e => handleChange('options_max_pct_per_trade', Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Min DTE (days)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.options_min_dte || 7}
                      onChange={e => handleChange('options_min_dte', Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max DTE (days)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.options_max_dte || 45}
                      onChange={e => handleChange('options_max_dte', Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Target Delta</label>
                    <input
                      type="number"
                      step="0.05"
                      className="hud-input w-full"
                      value={localConfig.options_target_delta || 0.35}
                      onChange={e => handleChange('options_target_delta', Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Stop Loss (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.options_stop_loss_pct || 50}
                      onChange={e => handleChange('options_stop_loss_pct', Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Take Profit (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.options_take_profit_pct || 100}
                      onChange={e => handleChange('options_take_profit_pct', Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-cyan">Crypto Trading (24/7)</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.crypto_enabled || false}
                        onChange={e => handleChange('crypto_enabled', e.target.checked)}
                      />
                      <span className="hud-label">Enable Crypto Trading</span>
                    </label>
                    <p className="text-[9px] text-hud-text-dim mt-1">Trade crypto 24/7 based on momentum. Alpaca supports 20+ coins.</p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Symbols (comma-separated)</label>
                    <input
                      type="text"
                      className="hud-input w-full"
                      value={(localConfig.crypto_symbols || ['BTC/USD', 'ETH/USD', 'SOL/USD']).join(', ')}
                      onChange={e => handleChange('crypto_symbols', e.target.value.split(',').map(s => s.trim()))}
                      disabled={!localConfig.crypto_enabled}
                      placeholder="BTC/USD, ETH/USD, SOL/USD, DOGE/USD, AVAX/USD..."
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Momentum Threshold (%)</label>
                    <input
                      type="number"
                      step="0.5"
                      className="hud-input w-full"
                      value={localConfig.crypto_momentum_threshold || 2.0}
                      onChange={e => handleChange('crypto_momentum_threshold', Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Position ($)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.crypto_max_position_value || 1000}
                      onChange={e => handleChange('crypto_max_position_value', Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Take Profit (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.crypto_take_profit_pct || 10}
                      onChange={e => handleChange('crypto_take_profit_pct', Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Stop Loss (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.crypto_stop_loss_pct || 5}
                      onChange={e => handleChange('crypto_stop_loss_pct', Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'ai' && (
            <div className="space-y-6">
              <div>
                <h3 className="hud-label mb-3 text-hud-primary">LLM Configuration</h3>
                <div className="grid grid-cols-1 gap-4 mb-4">
                  <div>
                    <label className="hud-label block mb-1">Provider</label>
                    <select
                      className="hud-input w-full"
                      value={llmProvider}
                      onChange={e => handleChange('llm_provider', e.target.value as Config['llm_provider'])}
                    >
                      <option value="openai-raw">OpenAI Official</option>
                      <option value="ai-sdk">AI SDK (5 providers)</option>
                      <option value="cloudflare-gateway">Cloudflare AI Gateway</option>
                      {localConfig.llm_provider &&
                        !['openai-raw', 'ai-sdk', 'cloudflare-gateway'].includes(localConfig.llm_provider) && (
                          <option value={localConfig.llm_provider}>Custom (backend configured)</option>
                        )}
                    </select>
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      {localConfig.llm_provider === 'ai-sdk' && 'Supports: OpenAI, Anthropic, Google, xAI, DeepSeek'}
                      {(!localConfig.llm_provider || localConfig.llm_provider === 'openai-raw') &&
                        'Uses the official OpenAI API key. If Base URL Override is set, that endpoint is used instead.'}
                      {localConfig.llm_provider &&
                        !['openai-raw', 'ai-sdk', 'cloudflare-gateway'].includes(localConfig.llm_provider) &&
                        'Provider is configured in the backend; selection is hidden in the dashboard.'}
                      {localConfig.llm_provider === 'cloudflare-gateway' && 'Uses CLOUDFLARE_AI_GATEWAY_* env vars via Cloudflare AI Gateway /compat.'}
                    </p>
                  </div>
                  {showOpenAIBaseUrl && (
                    <div>
                      <label className="hud-label block mb-1">OpenAI Base URL Override</label>
                      <input
                        type="text"
                        className="hud-input w-full"
                        value={localConfig.openai_base_url || ''}
                        onChange={e => handleChange('openai_base_url', e.target.value)}
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Research Model (cheap)</label>
                    <input
                      list="research-model-suggestions"
                      className="hud-input w-full"
                      value={localConfig.llm_model}
                      onChange={e => handleChange('llm_model', e.target.value)}
                      placeholder="Model name"
                    />
                    <datalist id="research-model-suggestions">
                      {researchModelSuggestions.map(model => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Analyst Model (smart)</label>
                    <input
                      list="analyst-model-suggestions"
                      className="hud-input w-full"
                      value={localConfig.llm_analyst_model || 'gpt-4o'}
                      onChange={e => handleChange('llm_analyst_model', e.target.value)}
                      placeholder="Model name"
                    />
                    <datalist id="analyst-model-suggestions">
                      {analystModelSuggestions.map(model => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'system' && (
            <div className="space-y-6">
              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Remote Link</h3>
                <div className="grid gap-3 md:grid-cols-[1.3fr_1fr_auto]">
                  <input
                    type="text"
                    className="hud-input"
                    value={apiUrl}
                    onChange={e => setApiUrl(e.target.value)}
                    placeholder="https://your-mahoraga.workers.dev"
                  />
                  <input
                    type="password"
                    className="hud-input"
                    value={apiToken}
                    onChange={e => setApiToken(e.target.value)}
                    placeholder="Bearer token"
                  />
                  <button className="hud-button" onClick={handleConnectionSave} disabled={connectionSaving}>
                    {connectionSaving ? 'LINKING...' : 'Reconnect'}
                  </button>
                </div>
                {connectionError && <p className="text-[10px] text-hud-error mt-2">{connectionError}</p>}
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Polling Intervals</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Data Poll (ms)</label>
                    <input
                      type="number"
                      step="1000"
                      className="hud-input w-full"
                      value={localConfig.data_poll_interval_ms}
                      onChange={e => handleChange('data_poll_interval_ms', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Analyst Interval (ms)</label>
                    <input
                      type="number"
                      step="1000"
                      className="hud-input w-full"
                      value={localConfig.analyst_interval_ms}
                      onChange={e => handleChange('analyst_interval_ms', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Pre-Market Plan Window (min)</label>
                    <input
                      type="number"
                      step="1"
                      min="1"
                      className="hud-input w-full"
                      value={localConfig.premarket_plan_window_minutes ?? 5}
                      onChange={e => handleChange('premarket_plan_window_minutes', Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">Generate a plan when within N minutes of the next market open.</p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Market Open Execute Window (min)</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      className="hud-input w-full"
                      value={localConfig.market_open_execute_window_minutes ?? 2}
                      onChange={e => handleChange('market_open_execute_window_minutes', Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">Execute the plan if the market is open and within this window.</p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Account</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Starting Equity ($)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.starting_equity || 100000}
                      onChange={e => handleChange('starting_equity', Number(e.target.value))}
                    />
                    <p className="text-xs text-hud-text-dim mt-1">For P&amp;L calculation</p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Discord Notifications</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.discord_daily_report_enabled ?? false}
                        onChange={e => handleChange('discord_daily_report_enabled', e.target.checked)}
                      />
                      <span className="hud-label">Enable Daily Discord Report</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Report Time</label>
                    <input
                      type="time"
                      className="hud-input w-full"
                      value={localConfig.discord_daily_report_time || '21:00'}
                      onChange={e => handleChange('discord_daily_report_time', e.target.value)}
                      disabled={!localConfig.discord_daily_report_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Time Zone</label>
                    <input
                      type="text"
                      className="hud-input w-full"
                      value={localConfig.discord_daily_report_timezone || 'UTC'}
                      onChange={e => handleChange('discord_daily_report_timezone', e.target.value)}
                      disabled={!localConfig.discord_daily_report_enabled}
                      placeholder="Asia/Tokyo"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-4 pt-4 border-t border-hud-line">
            <button className="hud-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="hud-button"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </div>
      </Panel>
    </div>
  )
}
