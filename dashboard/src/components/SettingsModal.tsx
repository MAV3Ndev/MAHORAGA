import { useEffect, useState } from "react";
import type { ConnectionSettings, DesktopUpdateEvent } from "../lib/connection";
import { getResponseError, normalizeApiUrl, requestAgent } from "../lib/connection";
import type { Config } from "../types";
import { Panel } from "./Panel";
import { UpdateControls } from "./UpdateControls";

const RESEARCH_MODEL_PRESETS: Record<string, string[]> = {
  "openai-raw": ["MiniMax-M3", "gpt-4o-mini", "gpt-4.1-mini", "gpt-4o"],
  "ai-sdk": [
    "openai/gpt-4o-mini",
    "openai/gpt-4.1-mini",
    "anthropic/claude-3-5-haiku-latest",
    "google/gemini-2.5-flash",
    "deepseek/deepseek-chat",
  ],
  "cloudflare-gateway": [
    "openai/gpt-4o-mini",
    "openai/gpt-5-mini",
    "anthropic/claude-haiku-4-5",
    "google-ai-studio/gemini-2.5-flash",
  ],
};

const ANALYST_MODEL_PRESETS: Record<string, string[]> = {
  "openai-raw": ["MiniMax-M3", "gpt-5.2-2025-12-11", "gpt-4.1", "gpt-4o"],
  "ai-sdk": [
    "openai/gpt-4o",
    "openai/o1",
    "anthropic/claude-sonnet-4-0",
    "google/gemini-2.5-pro",
    "xai/grok-4",
    "deepseek/deepseek-reasoner",
  ],
  "cloudflare-gateway": [
    "openai/gpt-5.2",
    "openai/gpt-5",
    "anthropic/claude-opus-4-5",
    "google-ai-studio/gemini-2.5-pro",
  ],
};

interface SettingsModalProps {
  config: Config;
  connection: ConnectionSettings;
  appVersion: string | null;
  updateStatus: DesktopUpdateEvent | null;
  updateBusy: boolean;
  showAppUpdateControls: boolean;
  onSave: (config: Config) => Promise<void> | void;
  onSaveConnection: (connection: ConnectionSettings) => Promise<void> | void;
  onCheckUpdate: () => void;
  onShowUpdateDetails: () => void;
  onClose: () => void;
}

type SettingsTab = "strategy" | "risk" | "assets" | "ai" | "system";

interface TradeReviewTuningSuggestion {
  priority?: "high" | "medium" | "low";
  direction?: "tighten" | "loosen" | "investigate";
  target?: string;
  config_keys?: string[];
  proposed_config_patch?: Partial<Config>;
  evidence?: Record<string, unknown>;
  suggestion?: string;
}

interface TradeReviewBucket {
  key: string;
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl_usd: number;
}

interface TradeReviewPayload {
  tuning_suggestions?: TradeReviewTuningSuggestion[];
  summary?: {
    totals?: {
      closed_trades?: number;
      open_trades?: number;
      win_rate?: number;
      total_pnl_usd?: number;
      profit_factor?: number | string | null;
      expectancy_usd?: number | null;
      avg_confidence?: number | null;
      confidence_calibration_gap?: number | null;
      avg_exit_efficiency_pct?: number | null;
      max_consecutive_losses?: number;
      current_consecutive_losses?: number;
      recent_closed_trades?: number;
      recent_win_rate?: number | null;
      recent_total_pnl_usd?: number;
    };
    buckets?: {
      by_exit_reason?: TradeReviewBucket[];
      by_asset_class?: TradeReviewBucket[];
      by_portfolio_bucket?: TradeReviewBucket[];
      by_symbol?: TradeReviewBucket[];
      by_confidence?: TradeReviewBucket[];
      by_entry_quality?: TradeReviewBucket[];
      by_entry_path?: TradeReviewBucket[];
      by_entry_selection_score?: TradeReviewBucket[];
      by_entry_spread_pct?: TradeReviewBucket[];
      by_entry_fill_delay?: TradeReviewBucket[];
      by_entry_quote_slippage_pct?: TradeReviewBucket[];
      by_entry_price_change_pct?: TradeReviewBucket[];
      by_research_confirmation?: TradeReviewBucket[];
      by_entry_session?: TradeReviewBucket[];
      by_entry_weekday?: TradeReviewBucket[];
      by_option_dte?: TradeReviewBucket[];
      by_option_delta?: TradeReviewBucket[];
      by_option_type?: TradeReviewBucket[];
      by_crypto_momentum?: TradeReviewBucket[];
      by_hold_time?: TradeReviewBucket[];
      by_pnl_pct?: TradeReviewBucket[];
      by_mfe_pct?: TradeReviewBucket[];
      by_mae_pct?: TradeReviewBucket[];
      by_giveback_pct?: TradeReviewBucket[];
      by_exit_efficiency_pct?: TradeReviewBucket[];
    };
  };
}

function formatBucketLabel(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function ReviewBucketList({
  title,
  buckets,
  limit = 3,
}: {
  title: string;
  buckets?: TradeReviewBucket[];
  limit?: number;
}) {
  if (!buckets?.length) return null;

  return (
    <div className="border-t border-hud-line/30 pt-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="hud-label">{title}</span>
        <span className="text-[10px] text-hud-text-dim">win/trades</span>
      </div>
      <div className="space-y-1">
        {buckets.slice(0, limit).map((bucket) => (
          <div key={`${title}-${bucket.key}`} className="grid grid-cols-[1fr_auto_auto] gap-2 text-[10px]">
            <span className="min-w-0 truncate text-hud-text-dim">{formatBucketLabel(bucket.key)}</span>
            <span
              className={bucket.losses > bucket.wins ? "tabular-nums text-hud-warning" : "tabular-nums text-hud-text"}
            >
              {bucket.wins}/{bucket.trades}
            </span>
            <span className="tabular-nums text-hud-text-dim">{(bucket.win_rate * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function parseCookieAccountLines(value: string): Array<{ cookies: string }> {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((cookies) => ({ cookies }));
}

function sanitizeCookieAccounts(
  accounts?: Array<{ label?: string; cookies: string }>,
  legacyCookies?: string
): Array<{ label?: string; cookies: string }> {
  const configuredAccounts = (accounts || [])
    .map((account) => ({
      ...account,
      label: account.label?.trim() || undefined,
      cookies: account.cookies.trim(),
    }))
    .filter((account) => account.cookies);
  if (configuredAccounts.length > 0) return configuredAccounts;
  return parseCookieAccountLines(legacyCookies || "");
}

function getEditableCookieAccounts(
  accounts?: Array<{ label?: string; cookies: string }>,
  legacyCookies?: string
): Array<{ label?: string; cookies: string }> {
  if (accounts && accounts.length > 0) return accounts;
  return parseCookieAccountLines(legacyCookies || "");
}

function getCookieAccountsForRequest(
  accounts?: Array<{ cookies: string }>,
  legacyCookies?: string
): Array<{ cookies: string }> {
  return sanitizeCookieAccounts(accounts, legacyCookies);
}

function CookieAccountsEditor({
  idPrefix,
  sourceLabel,
  accounts,
  legacyCookies,
  placeholder,
  onAdd,
  onChange,
  onRemove,
}: {
  idPrefix: string;
  sourceLabel: string;
  accounts?: Array<{ label?: string; cookies: string }>;
  legacyCookies?: string;
  placeholder: string;
  onAdd: () => void;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const editableAccounts = getEditableCookieAccounts(accounts, legacyCookies);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="hud-label">Cookie Accounts</span>
        <button type="button" className="hud-button hud-button-muted h-7 min-h-0 px-3 py-1 text-[9px]" onClick={onAdd}>
          Add Account
        </button>
      </div>
      {editableAccounts.length === 0 ? (
        <div className="border border-dashed border-hud-line/40 px-3 py-2 text-[10px] text-hud-text-dim">
          No cookie accounts configured. Blank uses the Worker secret.
        </div>
      ) : (
        <div className="space-y-2">
          {editableAccounts.map((account, index) => (
            <div key={`${idPrefix}-${index}`} className="border border-hud-line/40 p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="hud-label" htmlFor={`${idPrefix}-${index}`}>
                  {sourceLabel} Account {index + 1}
                </label>
                <button
                  type="button"
                  className="hud-button hud-button-muted h-7 min-h-0 px-3 py-1 text-[9px]"
                  onClick={() => onRemove(index)}
                >
                  Remove
                </button>
              </div>
              <textarea
                id={`${idPrefix}-${index}`}
                className="hud-input min-h-16 w-full resize-y font-mono text-[10px]"
                value={account.cookies}
                onChange={(event) => onChange(index, event.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                rows={2}
              />
            </div>
          ))}
        </div>
      )}
      <p className="mt-1 text-[9px] text-hud-text-dim">
        Configure each account separately. Rotation uses all non-empty accounts.
      </p>
    </div>
  );
}

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "strategy", label: "Strategy" },
  { id: "risk", label: "Risk" },
  { id: "assets", label: "Assets" },
  { id: "ai", label: "AI" },
  { id: "system", label: "System" },
];

const CONFIG_KEY_TABS: Partial<Record<keyof Config, SettingsTab>> = {
  min_analyst_confidence: "strategy",
  min_sentiment_score: "strategy",
  min_entry_quality: "strategy",
  min_entry_catalysts: "strategy",
  min_entry_signal_sources: "strategy",
  min_entry_signal_consensus: "strategy",
  single_source_entry_min_confidence: "strategy",
  max_entry_research_age_minutes: "strategy",
  min_entry_selection_score: "strategy",
  signal_research_limit: "strategy",
  data_poll_interval_ms: "system",
  analyst_interval_ms: "system",
  position_size_pct_of_cash: "strategy",
  max_position_value: "strategy",
  max_positions: "strategy",
  crypto_max_positions: "assets",
  max_positions_per_sector: "risk",
  max_daily_loss_pct: "risk",
  daily_loss_entry_guard_enabled: "risk",
  daily_loss_entry_guard_pct: "risk",
  daily_loss_guard_min_confidence: "risk",
  daily_loss_guard_min_entry_quality: "risk",
  open_position_loss_entry_guard_enabled: "risk",
  open_position_loss_entry_guard_pct: "risk",
  open_position_loss_guard_min_confidence: "risk",
  open_position_loss_guard_min_entry_quality: "risk",
  cooldown_minutes_after_loss: "risk",
  defensive_sell_cooldown_hours: "risk",
  max_daily_entry_orders: "risk",
  min_minutes_between_entries: "risk",
  llm_size_low_confidence_multiplier: "strategy",
  llm_size_medium_confidence_multiplier: "strategy",
  llm_size_conviction_scaling: "strategy",
  equity_entry_cooldown_minutes_after_open: "strategy",
  entry_rsi_min: "strategy",
  entry_rsi_max: "strategy",
  entry_timing_enabled: "strategy",
  entry_bb_lower_threshold: "strategy",
  entry_max_intraday_range_position: "strategy",
  max_entry_spread_pct: "strategy",
  min_entry_quote_size: "strategy",
  max_entry_price_change_pct: "strategy",
  bad_fill_exit_enabled: "strategy",
  bad_fill_max_slippage_pct: "strategy",
  bad_fill_loss_pct: "strategy",
  bad_fill_max_hold_minutes: "strategy",
  early_loss_exit_enabled: "risk",
  early_loss_exit_pct: "risk",
  early_loss_exit_max_hold_minutes: "risk",
  sentiment_reversal_exit_enabled: "risk",
  sentiment_reversal_min_hold_minutes: "risk",
  sentiment_reversal_loss_pct: "risk",
  sentiment_reversal_threshold: "risk",
  sentiment_reversal_min_sources: "risk",
  market_regime_enabled: "risk",
  exceptional_entry_confidence: "strategy",
  analyst_buy_requires_research_confirmation: "strategy",
  options_max_spread_pct: "strategy",
  options_early_loss_exit_enabled: "risk",
  options_early_loss_exit_pct: "risk",
  options_early_loss_exit_max_hold_minutes: "risk",
  adaptive_performance_block_enabled: "risk",
  adaptive_performance_min_trades: "risk",
  adaptive_performance_min_win_rate: "risk",
  ticker_blacklist: "assets",
  allowed_exchanges: "assets",
  twitter_cookies: "system",
  twitter_cookie_accounts: "system",
  reddit_cookies: "system",
  reddit_cookie_accounts: "system",
  reddit_user_agent: "system",
  alpha_vantage_api_key: "system",
  llm_api_key: "ai",
  anthropic_base_url: "ai",
};

export function SettingsModal({
  config,
  connection,
  appVersion,
  updateStatus,
  updateBusy,
  showAppUpdateControls,
  onSave,
  onSaveConnection,
  onCheckUpdate,
  onShowUpdateDetails,
  onClose,
}: SettingsModalProps) {
  const [localConfig, setLocalConfig] = useState<Config>(() => ({ ...config }));
  const [activeTab, setActiveTab] = useState<SettingsTab>("strategy");
  const [saving, setSaving] = useState(false);
  const [connectionSaving, setConnectionSaving] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [downloadingLogs, setDownloadingLogs] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadInsights, setDownloadInsights] = useState<TradeReviewPayload | null>(null);
  const [appliedSuggestionIds, setAppliedSuggestionIds] = useState<string[]>([]);
  const [downloadDays, setDownloadDays] = useState(90);
  const [downloadLimit, setDownloadLimit] = useState(500);
  const [downloadIncludeSnapshots, setDownloadIncludeSnapshots] = useState(true);
  const [testingDiscord, setTestingDiscord] = useState(false);
  const [discordTestMessage, setDiscordTestMessage] = useState<string | null>(null);
  const [discordTestError, setDiscordTestError] = useState<string | null>(null);
  const [testingTwitter, setTestingTwitter] = useState(false);
  const [twitterTestMessage, setTwitterTestMessage] = useState<string | null>(null);
  const [twitterTestError, setTwitterTestError] = useState<string | null>(null);
  const [testingReddit, setTestingReddit] = useState(false);
  const [redditTestMessage, setRedditTestMessage] = useState<string | null>(null);
  const [redditTestError, setRedditTestError] = useState<string | null>(null);
  const [apiUrl, setApiUrl] = useState(connection.apiUrl);
  const [apiToken, setApiToken] = useState(connection.bearerToken);
  const llmProvider = localConfig.llm_provider || "openai-raw";
  const researchModelSuggestions = RESEARCH_MODEL_PRESETS[llmProvider] || [];
  const analystModelSuggestions = ANALYST_MODEL_PRESETS[llmProvider] || [];
  const modelProvider = localConfig.llm_model?.split(/[/:]/)[0]?.toLowerCase() || "";
  const showOpenAIBaseUrl = llmProvider === "openai-raw" || (llmProvider === "ai-sdk" && modelProvider === "openai");
  const showAnthropicBaseUrl = llmProvider === "ai-sdk" && modelProvider === "anthropic";
  const showLlmApiKey = llmProvider === "openai-raw" || llmProvider === "ai-sdk";

  // Note: We intentionally do NOT sync localConfig with the config prop after initial mount.
  // This prevents the parent's polling (every 5s) from overwriting user's unsaved changes.

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const handleConnectionSave = async () => {
    const normalizedUrl = normalizeApiUrl(apiUrl);
    const trimmedToken = apiToken.trim();

    if (!normalizedUrl) {
      setConnectionError("API URL is required");
      return;
    }

    if (!trimmedToken) {
      setConnectionError("Bearer token is required");
      return;
    }

    setConnectionSaving(true);
    setConnectionError(null);

    try {
      await onSaveConnection({
        apiUrl: normalizedUrl,
        bearerToken: trimmedToken,
      });
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : "Failed to update remote link");
    } finally {
      setConnectionSaving(false);
    }
  };

  const handleDownloadLogs = async () => {
    const normalizedUrl = normalizeApiUrl(apiUrl);
    const trimmedToken = apiToken.trim();

    if (!normalizedUrl) {
      setDownloadError("API URL is required");
      return;
    }

    if (!trimmedToken) {
      setDownloadError("Bearer token is required");
      return;
    }

    setDownloadingLogs(true);
    setDownloadError(null);
    setDownloadInsights(null);

    try {
      const params = new URLSearchParams({
        days: String(Math.min(3650, Math.max(1, Math.floor(downloadDays) || 90))),
        limit: String(Math.min(1000, Math.max(1, Math.floor(downloadLimit) || 500))),
        include_snapshots: downloadIncludeSnapshots ? "true" : "false",
      });
      let response = await requestAgent<TradeReviewPayload | Record<string, unknown>>(
        "/trade-review?" + params.toString(),
        {
          connection: {
            apiUrl: normalizedUrl,
            bearerToken: trimmedToken,
          },
        }
      );

      if (response.status === 404) {
        response = await requestAgent<Record<string, unknown>>("/logs?limit=500", {
          connection: {
            apiUrl: normalizedUrl,
            bearerToken: trimmedToken,
          },
        });
      }

      if (!response.ok) {
        throw new Error(getResponseError(response.data, "Log download failed (" + response.status + ")"));
      }

      const payload = typeof response.data === "string" ? response.data : JSON.stringify(response.data, null, 2);
      if (response.data && typeof response.data === "object" && "tuning_suggestions" in response.data) {
        setDownloadInsights(response.data as TradeReviewPayload);
      }
      const blob = new Blob([payload], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "mahoraga-next-trade-review-" + new Date().toISOString().slice(0, 10) + ".json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setDownloadError(error instanceof Error ? error.message : "Log download failed");
    } finally {
      setDownloadingLogs(false);
    }
  };

  const handleTestDiscord = async () => {
    setTestingDiscord(true);
    setDiscordTestMessage(null);
    setDiscordTestError(null);

    try {
      const response = await requestAgent<{ ok?: boolean; message?: string; error?: string }>("/discord/test", {
        method: "POST",
        body: {
          webhook_url: localConfig.discord_webhook_url || "",
        },
        connection,
      });

      if (!response.ok) {
        throw new Error(getResponseError(response.data, "Discord test notification failed"));
      }

      setDiscordTestMessage(response.data?.message || "Discord test notification sent");
    } catch (error) {
      setDiscordTestError(error instanceof Error ? error.message : "Discord test notification failed");
    } finally {
      setTestingDiscord(false);
    }
  };

  const handleTestTwitter = async () => {
    setTestingTwitter(true);
    setTwitterTestMessage(null);
    setTwitterTestError(null);

    try {
      const accounts = getCookieAccountsForRequest(localConfig.twitter_cookie_accounts, localConfig.twitter_cookies);
      const response = await requestAgent<{
        ok?: boolean;
        message?: string;
        error?: string;
        data?: { account_count?: number; passed?: number };
      }>("/twitter/test", {
        method: "POST",
        body: {
          accounts,
          prefer_env: accounts.length === 0,
        },
        connection,
      });

      if (!response.ok) {
        throw new Error(getResponseError(response.data, "Twitter/X cookie test failed"));
      }

      const count = response.data?.data?.account_count;
      const passed = response.data?.data?.passed;
      setTwitterTestMessage(
        response.data?.message ||
          `Twitter/X cookie authentication succeeded${count ? ` (${passed ?? count}/${count} accounts)` : ""}`
      );
    } catch (error) {
      setTwitterTestError(error instanceof Error ? error.message : "Twitter/X cookie test failed");
    } finally {
      setTestingTwitter(false);
    }
  };

  const handleTestReddit = async () => {
    setTestingReddit(true);
    setRedditTestMessage(null);
    setRedditTestError(null);

    try {
      const accounts = getCookieAccountsForRequest(localConfig.reddit_cookie_accounts, localConfig.reddit_cookies);
      const response = await requestAgent<{
        ok?: boolean;
        message?: string;
        error?: string;
        data?: { account_count?: number; passed?: number; subreddit?: string };
      }>("/reddit/test", {
        method: "POST",
        body: {
          accounts,
          user_agent: localConfig.reddit_user_agent || "",
          prefer_env: accounts.length === 0,
        },
        connection,
      });

      if (!response.ok) {
        throw new Error(getResponseError(response.data, "Reddit cookie test failed"));
      }

      const count = response.data?.data?.account_count;
      const passed = response.data?.data?.passed;
      setRedditTestMessage(
        response.data?.message ||
          `Reddit cookie connection succeeded${count ? ` (${passed ?? count}/${count} accounts)` : ""}`
      );
    } catch (error) {
      setRedditTestError(error instanceof Error ? error.message : "Reddit cookie test failed");
    } finally {
      setTestingReddit(false);
    }
  };

  const updateTwitterCookieAccounts = (accounts: Array<{ label?: string; cookies: string }>) => {
    const sanitizedAccounts = sanitizeCookieAccounts(accounts);
    setLocalConfig((prev) => ({
      ...prev,
      twitter_cookie_accounts: accounts,
      twitter_cookies: sanitizedAccounts[0]?.cookies || "",
    }));
  };

  const updateRedditCookieAccounts = (accounts: Array<{ label?: string; cookies: string }>) => {
    const sanitizedAccounts = sanitizeCookieAccounts(accounts);
    setLocalConfig((prev) => ({
      ...prev,
      reddit_cookie_accounts: accounts,
      reddit_cookies: sanitizedAccounts[0]?.cookies || "",
    }));
  };

  const handleTwitterCookieAccountChange = (index: number, value: string) => {
    const pastedAccounts = parseCookieAccountLines(value);
    const accounts = getEditableCookieAccounts(localConfig.twitter_cookie_accounts, localConfig.twitter_cookies);
    if (pastedAccounts.length > 1) {
      updateTwitterCookieAccounts([...accounts.slice(0, index), ...pastedAccounts, ...accounts.slice(index + 1)]);
      return;
    }
    updateTwitterCookieAccounts(
      accounts.map((account, accountIndex) =>
        accountIndex === index ? { ...account, cookies: value.replace(/\r?\n/g, " ") } : account
      )
    );
  };

  const handleRedditCookieAccountChange = (index: number, value: string) => {
    const pastedAccounts = parseCookieAccountLines(value);
    const accounts = getEditableCookieAccounts(localConfig.reddit_cookie_accounts, localConfig.reddit_cookies);
    if (pastedAccounts.length > 1) {
      updateRedditCookieAccounts([...accounts.slice(0, index), ...pastedAccounts, ...accounts.slice(index + 1)]);
      return;
    }
    updateRedditCookieAccounts(
      accounts.map((account, accountIndex) =>
        accountIndex === index ? { ...account, cookies: value.replace(/\r?\n/g, " ") } : account
      )
    );
  };

  const handleAddTwitterCookieAccount = () => {
    updateTwitterCookieAccounts([
      ...getEditableCookieAccounts(localConfig.twitter_cookie_accounts, localConfig.twitter_cookies),
      { cookies: "" },
    ]);
  };

  const handleAddRedditCookieAccount = () => {
    updateRedditCookieAccounts([
      ...getEditableCookieAccounts(localConfig.reddit_cookie_accounts, localConfig.reddit_cookies),
      { cookies: "" },
    ]);
  };

  const handleRemoveTwitterCookieAccount = (index: number) => {
    updateTwitterCookieAccounts(
      getEditableCookieAccounts(localConfig.twitter_cookie_accounts, localConfig.twitter_cookies).filter(
        (_, accountIndex) => accountIndex !== index
      )
    );
  };

  const handleRemoveRedditCookieAccount = (index: number) => {
    updateRedditCookieAccounts(
      getEditableCookieAccounts(localConfig.reddit_cookie_accounts, localConfig.reddit_cookies).filter(
        (_, accountIndex) => accountIndex !== index
      )
    );
  };

  const handleChange = <K extends keyof Config>(key: K, value: Config[K]) => {
    setLocalConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleProfitLockActivationChange = (value: number) => {
    setLocalConfig((prev) => {
      const breakevenActivation = prev.breakeven_stop_activation_pct ?? 4;
      const maxActivation = Math.max(0, breakevenActivation - 0.05);
      const activation = clampNumber(value, 0, maxActivation);
      return {
        ...prev,
        profit_lock_activation_pct: activation,
        profit_lock_floor_pct: Math.min(prev.profit_lock_floor_pct ?? 0.5, activation),
      };
    });
  };

  const handleProfitLockFloorChange = (value: number) => {
    setLocalConfig((prev) => ({
      ...prev,
      profit_lock_floor_pct: clampNumber(value, 0, prev.profit_lock_activation_pct ?? 3),
    }));
  };

  const handleBreakevenActivationChange = (value: number) => {
    setLocalConfig((prev) => {
      const breakevenActivation = clampNumber(value, 0, 100);
      const maxProfitLockActivation = Math.max(0, breakevenActivation - 0.05);
      const profitLockActivation = Math.min(prev.profit_lock_activation_pct ?? 3, maxProfitLockActivation);
      return {
        ...prev,
        breakeven_stop_activation_pct: breakevenActivation,
        profit_lock_activation_pct: profitLockActivation,
        profit_lock_floor_pct: Math.min(prev.profit_lock_floor_pct ?? 0.5, profitLockActivation),
      };
    });
  };

  const handleApplyPatchCandidate = (patch: Partial<Config>, suggestionId?: string) => {
    setLocalConfig((prev) => ({ ...prev, ...patch }));
    if (suggestionId) {
      setAppliedSuggestionIds((prev) => (prev.includes(suggestionId) ? prev : [...prev, suggestionId]));
    }
    const firstKey = Object.keys(patch)[0] as keyof Config | undefined;
    if (firstKey && CONFIG_KEY_TABS[firstKey]) {
      setActiveTab(CONFIG_KEY_TABS[firstKey]);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const twitterCookieAccounts = sanitizeCookieAccounts(
        localConfig.twitter_cookie_accounts,
        localConfig.twitter_cookies
      );
      const redditCookieAccounts = sanitizeCookieAccounts(
        localConfig.reddit_cookie_accounts,
        localConfig.reddit_cookies
      );
      await onSave({
        ...localConfig,
        twitter_cookie_accounts: twitterCookieAccounts,
        twitter_cookies: twitterCookieAccounts[0]?.cookies || "",
        reddit_cookie_accounts: redditCookieAccounts,
        reddit_cookies: redditCookieAccounts[0]?.cookies || "",
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const tabButtonClass = (tab: SettingsTab) =>
    activeTab === tab
      ? "hud-button h-8 min-h-0 rounded-lg px-3 py-1.5 text-[10px] tracking-[0.12em]"
      : "hud-button hud-button-muted h-8 min-h-0 rounded-lg px-3 py-1.5 text-[10px] tracking-[0.12em]";

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
        <div onClick={(e) => e.stopPropagation()} className="space-y-6">
          <div className="border-b border-hud-line pb-4">
            <div className="flex flex-wrap gap-2">
              {SETTINGS_TABS.map((tab) => (
                <button key={tab.id} className={tabButtonClass(tab.id)} onClick={() => setActiveTab(tab.id)}>
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {activeTab === "strategy" && (
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
                      onChange={(e) => handleChange("max_position_value", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Positions</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.max_positions}
                      onChange={(e) => handleChange("max_positions", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Position Size (% of Cash)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.position_size_pct_of_cash}
                      onChange={(e) => handleChange("position_size_pct_of_cash", Number(e.target.value))}
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
                      onChange={(e) => handleChange("signal_research_limit", Number(e.target.value))}
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
                      onChange={(e) => handleChange("entry_candidate_limit", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      実際にエントリー判定まで進める上位候補数。増やすほどアグレッシブになります。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="max-entry-research-age-minutes">
                      Max Research Age (min)
                    </label>
                    <input
                      id="max-entry-research-age-minutes"
                      type="number"
                      min="1"
                      max="1440"
                      className="hud-input w-full"
                      value={localConfig.max_entry_research_age_minutes ?? 30}
                      onChange={(e) => handleChange("max_entry_research_age_minutes", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      BUY 研究がこの分数を超えたら古い判断としてエントリーを止めます。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="min-entry-selection-score">
                      Min Entry Selection Score
                    </label>
                    <input
                      id="min-entry-selection-score"
                      type="number"
                      step="0.01"
                      min="0"
                      max="2"
                      className="hud-input w-full"
                      value={localConfig.min_entry_selection_score ?? 0.85}
                      onChange={(e) => handleChange("min_entry_selection_score", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      confidence、quality、catalysts、source consensus を合成した entry score の最低ラインです。0
                      で無効化します。
                    </p>
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.analyst_buy_requires_research_confirmation ?? true}
                        onChange={(e) => handleChange("analyst_buy_requires_research_confirmation", e.target.checked)}
                      />
                      <span className="hud-label">Require Research Confirmation For Analyst BUY</span>
                    </label>
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Analyst や premarket の BUY を、同一銘柄の fresh BUY research で確認できる時だけ許可します。
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
                      onChange={(e) => handleChange("min_sentiment_score", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Min Analyst Confidence (0-1)</label>
                    <input
                      type="number"
                      step="0.05"
                      className="hud-input w-full"
                      value={localConfig.min_analyst_confidence}
                      onChange={(e) => handleChange("min_analyst_confidence", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Min Entry Signal Consensus (0-1)</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.min_entry_signal_consensus ?? 0.15}
                      onChange={(e) => handleChange("min_entry_signal_consensus", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Fresh signal の平均 consensus がこの値未満の BUY を避けます。0 で無効化します。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Single-Source Min Confidence (0-1)</label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.single_source_entry_min_confidence ?? 0.82}
                      onChange={(e) => handleChange("single_source_entry_min_confidence", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      独立ソースが 1 つだけの BUY は、この confidence 以上の時だけ許可します。
                    </p>
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
                        onChange={(e) => handleChange("entry_timing_enabled", e.target.checked)}
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
                      onChange={(e) => handleChange("entry_rsi_min", Number(e.target.value))}
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
                      onChange={(e) => handleChange("entry_rsi_max", Number(e.target.value))}
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
                      onChange={(e) => handleChange("entry_bb_lower_threshold", Number(e.target.value))}
                      disabled={!(localConfig.entry_timing_enabled ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      小さいほど押し目寄り、大きいほど広く許容します。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Intraday Range Position</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.entry_max_intraday_range_position ?? 0.75}
                      onChange={(e) => handleChange("entry_max_intraday_range_position", Number(e.target.value))}
                      disabled={!(localConfig.entry_timing_enabled ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      当日 high/low レンジ内の現在位置です。0.75 なら高値圏の追いかけ買いを止めます。
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Analyst Position Sizing</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.llm_size_conviction_scaling ?? true}
                        onChange={(e) => handleChange("llm_size_conviction_scaling", e.target.checked)}
                      />
                      <span className="hud-label">Enable Conviction-Based Sizing</span>
                    </label>
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      analyst BUY の confidence が低いほど、同じ上限設定でも実際の発注額を小さくします。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Low Confidence Multiplier</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.1"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.llm_size_low_confidence_multiplier ?? 0.4}
                      onChange={(e) => handleChange("llm_size_low_confidence_multiplier", Number(e.target.value))}
                      disabled={!(localConfig.llm_size_conviction_scaling ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">confidence 0.65 未満の BUY に適用します。</p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Medium Confidence Multiplier</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0.1"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.llm_size_medium_confidence_multiplier ?? 0.7}
                      onChange={(e) => handleChange("llm_size_medium_confidence_multiplier", Number(e.target.value))}
                      disabled={!(localConfig.llm_size_conviction_scaling ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      confidence 0.65 以上 0.75 未満の BUY に適用します。
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Open / Close Window Guards</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Entry Cooldown After Open (min)</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="120"
                      className="hud-input w-full"
                      value={localConfig.equity_entry_cooldown_minutes_after_open ?? 10}
                      onChange={(e) => handleChange("equity_entry_cooldown_minutes_after_open", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      寄り付き直後の株 BUY をこの分数だけ止めます。0 で無効化します。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Entry Cutoff Before Close (min)</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="120"
                      className="hud-input w-full"
                      value={localConfig.equity_entry_cutoff_minutes_before_close ?? 15}
                      onChange={(e) => handleChange("equity_entry_cutoff_minutes_before_close", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      この分数以内に入った株の新規エントリーを止めます。引け間際の持ち越し事故を減らす用です。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="max-entry-spread-pct">
                      Max Entry Spread (%)
                    </label>
                    <input
                      id="max-entry-spread-pct"
                      type="number"
                      step="0.1"
                      min="0"
                      max="10"
                      className="hud-input w-full"
                      value={localConfig.max_entry_spread_pct ?? 0.8}
                      onChange={(e) => handleChange("max_entry_spread_pct", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      株の BUY 直前に bid/ask spread がこの値を超えたら発注を止めます。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="max-entry-price-change-pct">
                      Max Entry Move From Prev Close (%)
                    </label>
                    <input
                      id="max-entry-price-change-pct"
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.max_entry_price_change_pct ?? 5}
                      onChange={(e) => handleChange("max_entry_price_change_pct", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      前日終値からこの割合以上に上げた株の BUY を止めます。0 で無効化します。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="min-entry-quote-size">
                      Min Entry Quote Size
                    </label>
                    <input
                      id="min-entry-quote-size"
                      type="number"
                      step="1"
                      min="0"
                      max="10000"
                      className="hud-input w-full"
                      value={localConfig.min_entry_quote_size ?? 1}
                      onChange={(e) => handleChange("min_entry_quote_size", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      株の BUY 直前に bid/ask の表示サイズがこの値未満なら発注を止めます。0 で無効化します。
                    </p>
                  </div>
                  <div className="flex items-start gap-3 pt-5">
                    <input
                      id="bad-fill-exit-enabled"
                      type="checkbox"
                      className="mt-1"
                      checked={localConfig.bad_fill_exit_enabled ?? true}
                      onChange={(e) => handleChange("bad_fill_exit_enabled", e.target.checked)}
                    />
                    <div>
                      <label className="hud-label block mb-1" htmlFor="bad-fill-exit-enabled">
                        Bad Fill Early Exit
                      </label>
                      <p className="text-[9px] text-hud-text-dim">
                        約定が quote mid より悪く、短時間で含み損になったポジションを早期撤退します。
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="bad-fill-max-slippage-pct">
                      Bad Fill Slippage (%)
                    </label>
                    <input
                      id="bad-fill-max-slippage-pct"
                      type="number"
                      step="0.1"
                      min="0"
                      max="10"
                      className="hud-input w-full"
                      value={localConfig.bad_fill_max_slippage_pct ?? 0.5}
                      onChange={(e) => handleChange("bad_fill_max_slippage_pct", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="bad-fill-loss-pct">
                      Bad Fill Loss (%)
                    </label>
                    <input
                      id="bad-fill-loss-pct"
                      type="number"
                      step="0.1"
                      min="0"
                      max="50"
                      className="hud-input w-full"
                      value={localConfig.bad_fill_loss_pct ?? 0.5}
                      onChange={(e) => handleChange("bad_fill_loss_pct", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="bad-fill-max-hold-minutes">
                      Bad Fill Window (min)
                    </label>
                    <input
                      id="bad-fill-max-hold-minutes"
                      type="number"
                      step="1"
                      min="0"
                      max="1440"
                      className="hud-input w-full"
                      value={localConfig.bad_fill_max_hold_minutes ?? 30}
                      onChange={(e) => handleChange("bad_fill_max_hold_minutes", Number(e.target.value))}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "risk" && (
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
                      onChange={(e) => handleChange("take_profit_pct", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Stop Loss (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.stop_loss_pct}
                      onChange={(e) => handleChange("stop_loss_pct", Number(e.target.value))}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input h-4 w-4"
                        checked={localConfig.early_loss_exit_enabled ?? true}
                        onChange={(e) => handleChange("early_loss_exit_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Early Loss Exit</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="early-loss-exit-pct">
                      Early Loss Exit (%)
                    </label>
                    <input
                      id="early-loss-exit-pct"
                      type="number"
                      step="0.25"
                      min="0"
                      max="50"
                      className="hud-input w-full"
                      value={localConfig.early_loss_exit_pct ?? 2.5}
                      onChange={(e) => handleChange("early_loss_exit_pct", Number(e.target.value))}
                      disabled={!(localConfig.early_loss_exit_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="early-loss-exit-window">
                      Early Loss Window (min)
                    </label>
                    <input
                      id="early-loss-exit-window"
                      type="number"
                      min="0"
                      max="1440"
                      className="hud-input w-full"
                      value={localConfig.early_loss_exit_max_hold_minutes ?? 90}
                      onChange={(e) => handleChange("early_loss_exit_max_hold_minutes", Number(e.target.value))}
                      disabled={!(localConfig.early_loss_exit_enabled ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Entry 直後の逆行を通常 stop loss より早く切ります。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">After-Hours Exit Limit Buffer (%)</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="5"
                      className="hud-input w-full"
                      value={localConfig.after_hours_exit_limit_buffer_pct ?? 0.25}
                      onChange={(e) => handleChange("after_hours_exit_limit_buffer_pct", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      時間外に exit するとき、bid や直近価格からこの分だけ下げた limit
                      で出します。大きいほど約定優先です。
                    </p>
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input h-4 w-4"
                        checked={localConfig.trailing_stop_enabled ?? true}
                        onChange={(e) => handleChange("trailing_stop_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Trailing Stop</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="trailing-stop-activation">
                      Trailing Activation (%)
                    </label>
                    <input
                      id="trailing-stop-activation"
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.trailing_stop_activation_pct ?? 6}
                      onChange={(e) => handleChange("trailing_stop_activation_pct", Number(e.target.value))}
                      disabled={!(localConfig.trailing_stop_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="trailing-stop-drawdown">
                      Trailing Drawdown (%)
                    </label>
                    <input
                      id="trailing-stop-drawdown"
                      type="number"
                      step="0.5"
                      min="0.1"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.trailing_stop_drawdown_pct ?? 3}
                      onChange={(e) => handleChange("trailing_stop_drawdown_pct", Number(e.target.value))}
                      disabled={!(localConfig.trailing_stop_enabled ?? true)}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input h-4 w-4"
                        checked={localConfig.breakeven_stop_enabled ?? true}
                        onChange={(e) => handleChange("breakeven_stop_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Breakeven Stop</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="breakeven-stop-activation">
                      Breakeven Activation (%)
                    </label>
                    <input
                      id="breakeven-stop-activation"
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.breakeven_stop_activation_pct ?? 4}
                      onChange={(e) => handleBreakevenActivationChange(Number(e.target.value))}
                      disabled={!(localConfig.breakeven_stop_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="breakeven-stop-buffer">
                      Breakeven Buffer (%)
                    </label>
                    <input
                      id="breakeven-stop-buffer"
                      type="number"
                      step="0.05"
                      min="0"
                      max="10"
                      className="hud-input w-full"
                      value={localConfig.breakeven_stop_buffer_pct ?? 0.25}
                      onChange={(e) => handleChange("breakeven_stop_buffer_pct", Number(e.target.value))}
                      disabled={!(localConfig.breakeven_stop_enabled ?? true)}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input h-4 w-4"
                        checked={localConfig.profit_lock_stop_enabled ?? true}
                        onChange={(e) => handleChange("profit_lock_stop_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Profit Lock Stop</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="profit-lock-activation">
                      Profit Lock Activation (%)
                    </label>
                    <input
                      id="profit-lock-activation"
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.profit_lock_activation_pct ?? 3}
                      onChange={(e) => handleProfitLockActivationChange(Number(e.target.value))}
                      disabled={!(localConfig.profit_lock_stop_enabled ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Must stay below breakeven activation ({localConfig.breakeven_stop_activation_pct ?? 4}%).
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="profit-lock-floor">
                      Profit Lock Floor (%)
                    </label>
                    <input
                      id="profit-lock-floor"
                      type="number"
                      step="0.05"
                      min="0"
                      max="10"
                      className="hud-input w-full"
                      value={localConfig.profit_lock_floor_pct ?? 0.5}
                      onChange={(e) => handleProfitLockFloorChange(Number(e.target.value))}
                      disabled={!(localConfig.profit_lock_stop_enabled ?? true)}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Must be at or below activation ({localConfig.profit_lock_activation_pct ?? 3}%).
                    </p>
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input h-4 w-4"
                        checked={localConfig.sentiment_reversal_exit_enabled ?? true}
                        onChange={(e) => handleChange("sentiment_reversal_exit_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Sentiment Reversal Loss Exit</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="sentiment-reversal-min-hold">
                      Reversal Min Hold (min)
                    </label>
                    <input
                      id="sentiment-reversal-min-hold"
                      type="number"
                      min="0"
                      max="1440"
                      className="hud-input w-full"
                      value={localConfig.sentiment_reversal_min_hold_minutes ?? 60}
                      onChange={(e) => handleChange("sentiment_reversal_min_hold_minutes", Number(e.target.value))}
                      disabled={!(localConfig.sentiment_reversal_exit_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="sentiment-reversal-loss">
                      Reversal Loss (%)
                    </label>
                    <input
                      id="sentiment-reversal-loss"
                      type="number"
                      step="0.25"
                      min="0"
                      max="50"
                      className="hud-input w-full"
                      value={localConfig.sentiment_reversal_loss_pct ?? 1.5}
                      onChange={(e) => handleChange("sentiment_reversal_loss_pct", Number(e.target.value))}
                      disabled={!(localConfig.sentiment_reversal_exit_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="sentiment-reversal-threshold">
                      Reversal Sentiment Threshold
                    </label>
                    <input
                      id="sentiment-reversal-threshold"
                      type="number"
                      step="0.05"
                      min="-1"
                      max="0"
                      className="hud-input w-full"
                      value={localConfig.sentiment_reversal_threshold ?? -0.25}
                      onChange={(e) => handleChange("sentiment_reversal_threshold", Number(e.target.value))}
                      disabled={!(localConfig.sentiment_reversal_exit_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="sentiment-reversal-sources">
                      Reversal Min Sources
                    </label>
                    <input
                      id="sentiment-reversal-sources"
                      type="number"
                      min="1"
                      max="10"
                      className="hud-input w-full"
                      value={localConfig.sentiment_reversal_min_sources ?? 1}
                      onChange={(e) => handleChange("sentiment_reversal_min_sources", Number(e.target.value))}
                      disabled={!(localConfig.sentiment_reversal_exit_enabled ?? true)}
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">LLM Exit Guard</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">LLM Min Hold (min)</label>
                    <input
                      type="number"
                      min="0"
                      className="hud-input w-full"
                      value={localConfig.llm_min_hold_minutes ?? 15}
                      onChange={(e) => handleChange("llm_min_hold_minutes", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">通常の LLM SELL を抑制する最低保有時間です。</p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Force Sell Loss Threshold (%)</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      className="hud-input w-full"
                      value={localConfig.llm_force_sell_pnl_pct ?? 2}
                      onChange={(e) => handleChange("llm_force_sell_pnl_pct", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      この損失幅を超えると、min hold 中でも強制 SELL を許可します。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Force Sell Min Confidence</label>
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.llm_force_sell_min_confidence ?? 0.65}
                      onChange={(e) => handleChange("llm_force_sell_min_confidence", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">強制 SELL を許可する最低 confidence です。</p>
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
                        onChange={(e) => handleChange("market_regime_enabled", e.target.checked)}
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
                      onChange={(e) => handleChange("regime_low_threshold", Number(e.target.value))}
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
                      onChange={(e) => handleChange("regime_position_size_reduction", Number(e.target.value))}
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
                  <div>
                    <label className="hud-label block mb-1" htmlFor="max-daily-loss-pct">
                      Max Daily Loss (%)
                    </label>
                    <input
                      id="max-daily-loss-pct"
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="100"
                      className="hud-input w-full"
                      value={((localConfig.max_daily_loss_pct ?? 0.02) * 100).toFixed(2)}
                      onChange={(e) =>
                        handleChange("max_daily_loss_pct", clampNumber(Number(e.target.value) / 100, 0.001, 1))
                      }
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="cooldown-minutes-after-loss">
                      Loss Cooldown (min)
                    </label>
                    <input
                      id="cooldown-minutes-after-loss"
                      type="number"
                      min="0"
                      max="1440"
                      className="hud-input w-full"
                      value={localConfig.cooldown_minutes_after_loss ?? 30}
                      onChange={(e) => handleChange("cooldown_minutes_after_loss", Number(e.target.value))}
                    />
                  </div>
                  <div className="flex items-start gap-3 pt-5">
                    <input
                      id="daily-loss-entry-guard-enabled"
                      type="checkbox"
                      className="mt-1"
                      checked={localConfig.daily_loss_entry_guard_enabled ?? true}
                      onChange={(e) => handleChange("daily_loss_entry_guard_enabled", e.target.checked)}
                    />
                    <div>
                      <label className="hud-label block mb-1" htmlFor="daily-loss-entry-guard-enabled">
                        Daily Loss Entry Guard
                      </label>
                      <p className="text-[9px] text-hud-text-dim">
                        当日損失が soft limit を超えたら、低 conviction の新規 BUY を止めます。
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="daily-loss-entry-guard-pct">
                      Daily Loss Soft Limit (%)
                    </label>
                    <input
                      id="daily-loss-entry-guard-pct"
                      type="number"
                      step="0.05"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={((localConfig.daily_loss_entry_guard_pct ?? 0.0075) * 100).toFixed(2)}
                      onChange={(e) =>
                        handleChange("daily_loss_entry_guard_pct", clampNumber(Number(e.target.value) / 100, 0, 1))
                      }
                      disabled={!(localConfig.daily_loss_entry_guard_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="daily-loss-guard-min-confidence">
                      Guard Min Confidence
                    </label>
                    <input
                      id="daily-loss-guard-min-confidence"
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.daily_loss_guard_min_confidence ?? 0.8}
                      onChange={(e) => handleChange("daily_loss_guard_min_confidence", Number(e.target.value))}
                      disabled={!(localConfig.daily_loss_entry_guard_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="daily-loss-guard-min-entry-quality">
                      Guard Min Quality
                    </label>
                    <select
                      id="daily-loss-guard-min-entry-quality"
                      className="hud-input w-full"
                      value={localConfig.daily_loss_guard_min_entry_quality ?? "good"}
                      onChange={(e) =>
                        handleChange(
                          "daily_loss_guard_min_entry_quality",
                          e.target.value as "excellent" | "good" | "fair" | "poor"
                        )
                      }
                      disabled={!(localConfig.daily_loss_entry_guard_enabled ?? true)}
                    >
                      <option value="excellent">excellent</option>
                      <option value="good">good</option>
                      <option value="fair">fair</option>
                      <option value="poor">poor</option>
                    </select>
                  </div>
                  <div className="flex items-start gap-3 pt-5">
                    <input
                      id="open-position-loss-entry-guard-enabled"
                      type="checkbox"
                      className="mt-1"
                      checked={localConfig.open_position_loss_entry_guard_enabled ?? true}
                      onChange={(e) => handleChange("open_position_loss_entry_guard_enabled", e.target.checked)}
                    />
                    <div>
                      <label className="hud-label block mb-1" htmlFor="open-position-loss-entry-guard-enabled">
                        Open Position Loss Guard
                      </label>
                      <p className="text-[9px] text-hud-text-dim">
                        保有中ポジションの含み損が soft limit を超えたら、弱い新規 BUY を止めます。
                      </p>
                    </div>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="open-position-loss-entry-guard-pct">
                      Open Loss Soft Limit (%)
                    </label>
                    <input
                      id="open-position-loss-entry-guard-pct"
                      type="number"
                      step="0.05"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={((localConfig.open_position_loss_entry_guard_pct ?? 0.01) * 100).toFixed(2)}
                      onChange={(e) =>
                        handleChange(
                          "open_position_loss_entry_guard_pct",
                          clampNumber(Number(e.target.value) / 100, 0, 1)
                        )
                      }
                      disabled={!(localConfig.open_position_loss_entry_guard_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="open-position-loss-guard-min-confidence">
                      Open Loss Min Confidence
                    </label>
                    <input
                      id="open-position-loss-guard-min-confidence"
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.open_position_loss_guard_min_confidence ?? 0.85}
                      onChange={(e) => handleChange("open_position_loss_guard_min_confidence", Number(e.target.value))}
                      disabled={!(localConfig.open_position_loss_entry_guard_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="open-position-loss-guard-min-entry-quality">
                      Open Loss Min Quality
                    </label>
                    <select
                      id="open-position-loss-guard-min-entry-quality"
                      className="hud-input w-full"
                      value={localConfig.open_position_loss_guard_min_entry_quality ?? "excellent"}
                      onChange={(e) =>
                        handleChange(
                          "open_position_loss_guard_min_entry_quality",
                          e.target.value as "excellent" | "good" | "fair" | "poor"
                        )
                      }
                      disabled={!(localConfig.open_position_loss_entry_guard_enabled ?? true)}
                    >
                      <option value="excellent">excellent</option>
                      <option value="good">good</option>
                      <option value="fair">fair</option>
                      <option value="poor">poor</option>
                    </select>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="defensive-sell-cooldown-hours">
                      Defensive Sell Cooldown (h)
                    </label>
                    <input
                      id="defensive-sell-cooldown-hours"
                      type="number"
                      min="0"
                      max="1440"
                      className="hud-input w-full"
                      value={localConfig.defensive_sell_cooldown_hours ?? 168}
                      onChange={(e) => handleChange("defensive_sell_cooldown_hours", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Stop loss や bad fill など防御的 SELL 後の同一銘柄再エントリーを長めに止めます。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="max-daily-entry-orders">
                      Max Daily Entries
                    </label>
                    <input
                      id="max-daily-entry-orders"
                      type="number"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.max_daily_entry_orders ?? 8}
                      onChange={(e) => handleChange("max_daily_entry_orders", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="min-minutes-between-entries">
                      Min Entry Gap (min)
                    </label>
                    <input
                      id="min-minutes-between-entries"
                      type="number"
                      min="0"
                      max="1440"
                      className="hud-input w-full"
                      value={localConfig.min_minutes_between_entries ?? 5}
                      onChange={(e) => handleChange("min_minutes_between_entries", Number(e.target.value))}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.portfolio_risk_enabled ?? true}
                        onChange={(e) => handleChange("portfolio_risk_enabled", e.target.checked)}
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
                      onChange={(e) => handleChange("max_positions_per_sector", Number(e.target.value))}
                      disabled={!(localConfig.portfolio_risk_enabled ?? true)}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input h-4 w-4"
                        checked={localConfig.adaptive_performance_block_enabled ?? true}
                        onChange={(e) => handleChange("adaptive_performance_block_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Recent Performance Guard</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="adaptive-performance-lookback-days">
                      Performance Lookback Days
                    </label>
                    <input
                      id="adaptive-performance-lookback-days"
                      type="number"
                      min="1"
                      max="3650"
                      className="hud-input w-full"
                      value={localConfig.adaptive_performance_lookback_days ?? 90}
                      onChange={(e) => handleChange("adaptive_performance_lookback_days", Number(e.target.value))}
                      disabled={!(localConfig.adaptive_performance_block_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="adaptive-performance-min-trades">
                      Min Trades Before Block
                    </label>
                    <input
                      id="adaptive-performance-min-trades"
                      type="number"
                      min="1"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.adaptive_performance_min_trades ?? 3}
                      onChange={(e) => handleChange("adaptive_performance_min_trades", Number(e.target.value))}
                      disabled={!(localConfig.adaptive_performance_block_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1" htmlFor="adaptive-performance-min-win-rate">
                      Min Recent Win Rate
                    </label>
                    <input
                      id="adaptive-performance-min-win-rate"
                      type="number"
                      step="0.05"
                      min="0"
                      max="1"
                      className="hud-input w-full"
                      value={localConfig.adaptive_performance_min_win_rate ?? 0.35}
                      onChange={(e) => handleChange("adaptive_performance_min_win_rate", Number(e.target.value))}
                      disabled={!(localConfig.adaptive_performance_block_enabled ?? true)}
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
                        onChange={(e) => handleChange("stale_position_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Stale Position Detection</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Timed Loss Exit (%)</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="50"
                      className="hud-input w-full"
                      value={localConfig.stale_loss_exit_pct ?? 2}
                      onChange={(e) => handleChange("stale_loss_exit_pct", Number(e.target.value))}
                      disabled={!localConfig.stale_position_enabled}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Exit after min hold hours if unrealized loss reaches this level. Set 0 to disable.
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Hold Days</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.stale_max_hold_days || 3}
                      onChange={(e) => handleChange("stale_max_hold_days", Number(e.target.value))}
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
                      onChange={(e) => handleChange("stale_min_gain_pct", Number(e.target.value))}
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
                      onChange={(e) => handleChange("stale_social_volume_decay", Number(e.target.value))}
                      disabled={!localConfig.stale_position_enabled}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">Exit if volume drops to this % of entry</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "assets" && (
            <div className="space-y-6">
              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Equity Universe</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <label className="hud-label block mb-1">Allowed Exchanges</label>
                    <input
                      type="text"
                      className="hud-input w-full"
                      value={(localConfig.allowed_exchanges || ["NYSE", "NASDAQ", "ARCA", "AMEX", "BATS"]).join(", ")}
                      onChange={(e) =>
                        handleChange(
                          "allowed_exchanges",
                          e.target.value
                            .split(",")
                            .map((s) => s.trim().toUpperCase())
                            .filter(Boolean)
                        )
                      }
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      BUY 前に銘柄の上場先を確認します。薄い市場を避けたい時に絞ります。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Ticker Blacklist</label>
                    <input
                      type="text"
                      className="hud-input w-full"
                      value={(localConfig.ticker_blacklist || []).join(", ")}
                      onChange={(e) =>
                        handleChange(
                          "ticker_blacklist",
                          e.target.value
                            .split(",")
                            .map((s) => s.trim().toUpperCase())
                            .filter(Boolean)
                        )
                      }
                      placeholder="MULN, HOLO, ..."
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      高スプレッドや低品質な約定が続く銘柄を autonomous BUY から外します。
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-purple">Options Trading (Beta)</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.options_enabled || false}
                        onChange={(e) => handleChange("options_enabled", e.target.checked)}
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
                      onChange={(e) => handleChange("options_min_confidence", Number(e.target.value))}
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
                      onChange={(e) => handleChange("options_max_pct_per_trade", Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Min DTE (days)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.options_min_dte || 7}
                      onChange={(e) => handleChange("options_min_dte", Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max DTE (days)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.options_max_dte || 45}
                      onChange={(e) => handleChange("options_max_dte", Number(e.target.value))}
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
                      onChange={(e) => handleChange("options_target_delta", Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Spread (%)</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.options_max_spread_pct ?? 8}
                      onChange={(e) => handleChange("options_max_spread_pct", Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input h-4 w-4"
                        checked={localConfig.options_early_loss_exit_enabled ?? true}
                        onChange={(e) => handleChange("options_early_loss_exit_enabled", e.target.checked)}
                        disabled={!localConfig.options_enabled}
                      />
                      <span className="hud-label">Enable Options Early Loss Exit</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Early Loss Exit (%)</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.options_early_loss_exit_pct ?? 25}
                      onChange={(e) => handleChange("options_early_loss_exit_pct", Number(e.target.value))}
                      disabled={!localConfig.options_enabled || !(localConfig.options_early_loss_exit_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Early Loss Window (min)</label>
                    <input
                      type="number"
                      min="0"
                      max="1440"
                      className="hud-input w-full"
                      value={localConfig.options_early_loss_exit_max_hold_minutes ?? 60}
                      onChange={(e) => handleChange("options_early_loss_exit_max_hold_minutes", Number(e.target.value))}
                      disabled={!localConfig.options_enabled || !(localConfig.options_early_loss_exit_enabled ?? true)}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Stop Loss (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.options_stop_loss_pct || 50}
                      onChange={(e) => handleChange("options_stop_loss_pct", Number(e.target.value))}
                      disabled={!localConfig.options_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Take Profit (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.options_take_profit_pct || 100}
                      onChange={(e) => handleChange("options_take_profit_pct", Number(e.target.value))}
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
                        onChange={(e) => handleChange("crypto_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Crypto Trading</span>
                    </label>
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Trade crypto 24/7 based on momentum. Alpaca supports 20+ coins.
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Symbols (comma-separated)</label>
                    <input
                      type="text"
                      className="hud-input w-full"
                      value={(localConfig.crypto_symbols || ["BTC/USD", "ETH/USD", "SOL/USD"]).join(", ")}
                      onChange={(e) =>
                        handleChange(
                          "crypto_symbols",
                          e.target.value.split(",").map((s) => s.trim())
                        )
                      }
                      disabled={!localConfig.crypto_enabled}
                      placeholder="BTC/USD, ETH/USD, SOL/USD, DOGE/USD, AVAX/USD..."
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Crypto Positions</label>
                    <input
                      type="number"
                      min="1"
                      max="50"
                      step="1"
                      className="hud-input w-full"
                      value={localConfig.crypto_max_positions ?? 3}
                      onChange={(e) => handleChange("crypto_max_positions", clampNumber(Number(e.target.value), 1, 50))}
                      disabled={!localConfig.crypto_enabled}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">Configured crypto symbols still cap this value.</p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Momentum Threshold (%)</label>
                    <input
                      type="number"
                      step="0.5"
                      className="hud-input w-full"
                      value={localConfig.crypto_momentum_threshold || 2.0}
                      onChange={(e) => handleChange("crypto_momentum_threshold", Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Momentum (%)</label>
                    <input
                      type="number"
                      step="0.5"
                      min="0"
                      max="100"
                      className="hud-input w-full"
                      value={localConfig.crypto_max_momentum_pct ?? 12}
                      onChange={(e) => handleChange("crypto_max_momentum_pct", Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      0 で無効化します。過熱した急騰追いかけを止めます。
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Max Position ($)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.crypto_max_position_value || 1000}
                      onChange={(e) => handleChange("crypto_max_position_value", Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Take Profit (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.crypto_take_profit_pct || 10}
                      onChange={(e) => handleChange("crypto_take_profit_pct", Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Stop Loss (%)</label>
                    <input
                      type="number"
                      className="hud-input w-full"
                      value={localConfig.crypto_stop_loss_pct || 5}
                      onChange={(e) => handleChange("crypto_stop_loss_pct", Number(e.target.value))}
                      disabled={!localConfig.crypto_enabled}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "ai" && (
            <div className="space-y-6">
              <div>
                <h3 className="hud-label mb-3 text-hud-primary">LLM Configuration</h3>
                <div className="grid grid-cols-1 gap-4 mb-4">
                  <div>
                    <label className="hud-label block mb-1">Provider</label>
                    <select
                      className="hud-input w-full"
                      value={llmProvider}
                      onChange={(e) => handleChange("llm_provider", e.target.value as Config["llm_provider"])}
                    >
                      <option value="openai-raw">OpenAI Official</option>
                      <option value="ai-sdk">AI SDK (5 providers)</option>
                      <option value="cloudflare-gateway">Cloudflare AI Gateway</option>
                      {localConfig.llm_provider &&
                        !["openai-raw", "ai-sdk", "cloudflare-gateway"].includes(localConfig.llm_provider) && (
                          <option value={localConfig.llm_provider}>Custom (backend configured)</option>
                        )}
                    </select>
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      {localConfig.llm_provider === "ai-sdk" &&
                        "Supports: OpenAI, Anthropic, Google, xAI, DeepSeek."}
                      {(!localConfig.llm_provider || localConfig.llm_provider === "openai-raw") &&
                        "Uses OpenAI-compatible Chat Completions. Set Base URL Override for MiniMax or other compatible endpoints."}
                      {localConfig.llm_provider &&
                        !["openai-raw", "ai-sdk", "cloudflare-gateway"].includes(localConfig.llm_provider) &&
                        "Provider is configured in the backend; selection is hidden in the dashboard."}
                      {localConfig.llm_provider === "cloudflare-gateway" &&
                        "Uses CLOUDFLARE_AI_GATEWAY_* env vars via Cloudflare AI Gateway /compat."}
                    </p>
                  </div>
                  {showLlmApiKey && (
                    <div>
                      <label className="hud-label block mb-1" htmlFor="llm-api-key">
                        LLM API Key
                      </label>
                      <input
                        id="llm-api-key"
                        type="password"
                        className="hud-input w-full"
                        value={localConfig.llm_api_key || ""}
                        onChange={(e) => handleChange("llm_api_key", e.target.value)}
                        placeholder="sk-..."
                      />
                    </div>
                  )}
                  {showOpenAIBaseUrl && (
                    <div>
                      <label className="hud-label block mb-1" htmlFor="openai-base-url">
                        OpenAI Base URL Override
                      </label>
                      <input
                        id="openai-base-url"
                        type="text"
                        className="hud-input w-full"
                        value={localConfig.openai_base_url || ""}
                        onChange={(e) => handleChange("openai_base_url", e.target.value)}
                        placeholder="https://api.minimaxi.com/v1"
                      />
                    </div>
                  )}
                  {showAnthropicBaseUrl && (
                    <div>
                      <label className="hud-label block mb-1" htmlFor="anthropic-base-url">
                        Anthropic-Compatible Base URL
                      </label>
                      <input
                        id="anthropic-base-url"
                        type="text"
                        className="hud-input w-full"
                        value={localConfig.anthropic_base_url || ""}
                        onChange={(e) => handleChange("anthropic_base_url", e.target.value)}
                        placeholder="https://api.anthropic.com/v1"
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
                      onChange={(e) => handleChange("llm_model", e.target.value)}
                      placeholder="Model name"
                    />
                    <datalist id="research-model-suggestions">
                      {researchModelSuggestions.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Analyst Model (smart)</label>
                    <input
                      list="analyst-model-suggestions"
                      className="hud-input w-full"
                      value={localConfig.llm_analyst_model || "gpt-4o"}
                      onChange={(e) => handleChange("llm_analyst_model", e.target.value)}
                      placeholder="Model name"
                    />
                    <datalist id="analyst-model-suggestions">
                      {analystModelSuggestions.map((model) => (
                        <option key={model} value={model} />
                      ))}
                    </datalist>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === "system" && (
            <div className="space-y-6">
              {showAppUpdateControls && (
                <UpdateControls
                  appVersion={appVersion}
                  updateStatus={updateStatus}
                  updateBusy={updateBusy}
                  compact
                  onCheckUpdate={onCheckUpdate}
                  onShowUpdateDetails={onShowUpdateDetails}
                />
              )}

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Remote Link</h3>
                <div className="grid gap-3 md:grid-cols-[1.3fr_1fr_auto]">
                  <input
                    type="text"
                    className="hud-input"
                    value={apiUrl}
                    onChange={(e) => setApiUrl(e.target.value)}
                    placeholder="https://your-mahoraga-next.workers.dev"
                  />
                  <input
                    type="password"
                    className="hud-input"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="Bearer token"
                  />
                  <button className="hud-button" onClick={handleConnectionSave} disabled={connectionSaving}>
                    {connectionSaving ? "LINKING..." : "Reconnect"}
                  </button>
                </div>
                {connectionError && <p className="text-[10px] text-hud-error mt-2">{connectionError}</p>}
                <div className="mt-3 grid gap-3 md:grid-cols-[110px_110px_1fr_auto]">
                  <div>
                    <label className="hud-label mb-1 block">Days</label>
                    <input
                      type="number"
                      min="1"
                      max="3650"
                      className="hud-input w-full"
                      value={downloadDays}
                      onChange={(e) => setDownloadDays(Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label mb-1 block">Rows</label>
                    <input
                      type="number"
                      min="1"
                      max="1000"
                      className="hud-input w-full"
                      value={downloadLimit}
                      onChange={(e) => setDownloadLimit(Number(e.target.value))}
                    />
                  </div>
                  <label className="flex items-end gap-2 pb-2">
                    <input
                      type="checkbox"
                      className="hud-input h-4 w-4"
                      checked={downloadIncludeSnapshots}
                      onChange={(e) => setDownloadIncludeSnapshots(e.target.checked)}
                    />
                    <span className="hud-label">Include recent R2 snapshots</span>
                  </label>
                  <button
                    type="button"
                    className="hud-button self-end"
                    onClick={handleDownloadLogs}
                    disabled={downloadingLogs}
                  >
                    {downloadingLogs ? "Downloading..." : "Download Logs"}
                  </button>
                </div>
                <p className="mt-2 text-[10px] text-hud-text-dim">
                  Use snapshots for deep trade review; turn them off for a lighter runtime/blocker export.
                </p>
                {downloadError && <p className="text-[10px] text-hud-error mt-2">{downloadError}</p>}
                {downloadInsights && (
                  <div className="mt-3 border border-hud-line bg-hud-bg/40 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="hud-label text-hud-primary">Latest Review Insights</span>
                      <span className="hud-value-sm">
                        {downloadInsights.summary?.totals?.closed_trades ?? 0} closed
                      </span>
                    </div>
                    <div className="mb-3 grid grid-cols-3 gap-2 text-[10px]">
                      <div>
                        <div className="hud-label">Win Rate</div>
                        <div className="hud-value-sm">
                          {(((downloadInsights.summary?.totals?.win_rate ?? 0) as number) * 100).toFixed(0)}%
                        </div>
                      </div>
                      <div>
                        <div className="hud-label">Open</div>
                        <div className="hud-value-sm">{downloadInsights.summary?.totals?.open_trades ?? 0}</div>
                      </div>
                      <div>
                        <div className="hud-label">P/L</div>
                        <div className="hud-value-sm">
                          ${((downloadInsights.summary?.totals?.total_pnl_usd ?? 0) as number).toFixed(2)}
                        </div>
                      </div>
                      <div>
                        <div className="hud-label">PF</div>
                        <div className="hud-value-sm">
                          {typeof downloadInsights.summary?.totals?.profit_factor === "number"
                            ? downloadInsights.summary.totals.profit_factor.toFixed(2)
                            : downloadInsights.summary?.totals?.profit_factor || "-"}
                        </div>
                      </div>
                      <div>
                        <div className="hud-label">Expectancy</div>
                        <div className="hud-value-sm">
                          ${((downloadInsights.summary?.totals?.expectancy_usd ?? 0) as number).toFixed(2)}
                        </div>
                      </div>
                      <div>
                        <div className="hud-label">Exit Eff</div>
                        <div className="hud-value-sm">
                          {downloadInsights.summary?.totals?.avg_exit_efficiency_pct === null ||
                          downloadInsights.summary?.totals?.avg_exit_efficiency_pct === undefined
                            ? "-"
                            : `${downloadInsights.summary.totals.avg_exit_efficiency_pct.toFixed(0)}%`}
                        </div>
                      </div>
                      <div>
                        <div className="hud-label">Avg Conf</div>
                        <div className="hud-value-sm">
                          {downloadInsights.summary?.totals?.avg_confidence === null ||
                          downloadInsights.summary?.totals?.avg_confidence === undefined
                            ? "-"
                            : `${(downloadInsights.summary.totals.avg_confidence * 100).toFixed(0)}%`}
                        </div>
                      </div>
                      <div>
                        <div className="hud-label">Cal Gap</div>
                        <div className="hud-value-sm">
                          {downloadInsights.summary?.totals?.confidence_calibration_gap === null ||
                          downloadInsights.summary?.totals?.confidence_calibration_gap === undefined
                            ? "-"
                            : `${(downloadInsights.summary.totals.confidence_calibration_gap * 100).toFixed(0)}pt`}
                        </div>
                      </div>
                      <div>
                        <div className="hud-label">Streak</div>
                        <div className="hud-value-sm">
                          L{downloadInsights.summary?.totals?.current_consecutive_losses ?? 0}/
                          {downloadInsights.summary?.totals?.max_consecutive_losses ?? 0}
                        </div>
                      </div>
                      <div>
                        <div className="hud-label">Recent WR</div>
                        <div className="hud-value-sm">
                          {downloadInsights.summary?.totals?.recent_win_rate === null ||
                          downloadInsights.summary?.totals?.recent_win_rate === undefined
                            ? "-"
                            : `${(downloadInsights.summary.totals.recent_win_rate * 100).toFixed(0)}%`}
                        </div>
                      </div>
                    </div>
                    <div className="mb-3 space-y-2">
                      <ReviewBucketList
                        title="Exit Reasons"
                        buckets={downloadInsights.summary?.buckets?.by_exit_reason}
                      />
                      <ReviewBucketList
                        title="Asset Class"
                        buckets={downloadInsights.summary?.buckets?.by_asset_class}
                      />
                      <ReviewBucketList
                        title="Portfolio Bucket"
                        buckets={downloadInsights.summary?.buckets?.by_portfolio_bucket}
                      />
                      <ReviewBucketList title="Symbol" buckets={downloadInsights.summary?.buckets?.by_symbol} />
                      <ReviewBucketList title="Confidence" buckets={downloadInsights.summary?.buckets?.by_confidence} />
                      <ReviewBucketList
                        title="Entry Quality"
                        buckets={downloadInsights.summary?.buckets?.by_entry_quality}
                      />
                      <ReviewBucketList title="Entry Path" buckets={downloadInsights.summary?.buckets?.by_entry_path} />
                      <ReviewBucketList
                        title="Entry Score"
                        buckets={downloadInsights.summary?.buckets?.by_entry_selection_score}
                      />
                      <ReviewBucketList
                        title="Entry Spread"
                        buckets={downloadInsights.summary?.buckets?.by_entry_spread_pct}
                      />
                      <ReviewBucketList
                        title="Entry Fill Delay"
                        buckets={downloadInsights.summary?.buckets?.by_entry_fill_delay}
                      />
                      <ReviewBucketList
                        title="Entry Slippage"
                        buckets={downloadInsights.summary?.buckets?.by_entry_quote_slippage_pct}
                      />
                      <ReviewBucketList
                        title="Entry Move"
                        buckets={downloadInsights.summary?.buckets?.by_entry_price_change_pct}
                      />
                      <ReviewBucketList
                        title="Research"
                        buckets={downloadInsights.summary?.buckets?.by_research_confirmation}
                      />
                      <ReviewBucketList
                        title="Entry Session"
                        buckets={downloadInsights.summary?.buckets?.by_entry_session}
                      />
                      <ReviewBucketList
                        title="Entry Weekday"
                        buckets={downloadInsights.summary?.buckets?.by_entry_weekday}
                      />
                      <ReviewBucketList title="Option DTE" buckets={downloadInsights.summary?.buckets?.by_option_dte} />
                      <ReviewBucketList
                        title="Option Delta"
                        buckets={downloadInsights.summary?.buckets?.by_option_delta}
                      />
                      <ReviewBucketList
                        title="Option Type"
                        buckets={downloadInsights.summary?.buckets?.by_option_type}
                      />
                      <ReviewBucketList
                        title="Crypto Momentum"
                        buckets={downloadInsights.summary?.buckets?.by_crypto_momentum}
                      />
                      <ReviewBucketList title="Hold Time" buckets={downloadInsights.summary?.buckets?.by_hold_time} />
                      <ReviewBucketList title="P/L Buckets" buckets={downloadInsights.summary?.buckets?.by_pnl_pct} />
                      <ReviewBucketList title="MFE Buckets" buckets={downloadInsights.summary?.buckets?.by_mfe_pct} />
                      <ReviewBucketList title="MAE Buckets" buckets={downloadInsights.summary?.buckets?.by_mae_pct} />
                      <ReviewBucketList
                        title="Giveback Buckets"
                        buckets={downloadInsights.summary?.buckets?.by_giveback_pct}
                      />
                      <ReviewBucketList
                        title="Exit Efficiency"
                        buckets={downloadInsights.summary?.buckets?.by_exit_efficiency_pct}
                      />
                    </div>
                    {downloadInsights.tuning_suggestions?.length ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="hud-label text-hud-primary">Tuning Suggestions</span>
                          <span className="text-[10px] text-hud-text-dim">
                            {downloadInsights.tuning_suggestions.length} total
                          </span>
                        </div>
                        {downloadInsights.tuning_suggestions.map((item, index) => {
                          const suggestionId = `${index}-${item.priority || "low"}-${item.direction || "investigate"}-${item.target || "review"}`;
                          const patchEntries = Object.entries(item.proposed_config_patch || {});
                          const applied = appliedSuggestionIds.includes(suggestionId);

                          return (
                            <div key={suggestionId} className="border border-hud-line/50 bg-hud-bg/50 p-2">
                              <div className="mb-1 flex items-center justify-between gap-2">
                                <span className="hud-label text-hud-text">
                                  {(item.priority || "low").toUpperCase()} /{" "}
                                  {(item.direction || "investigate").toUpperCase()}
                                </span>
                                <span className="hud-label text-hud-text-dim">{item.target || "review"}</span>
                              </div>
                              <p className="text-[10px] leading-snug text-hud-text-dim">{item.suggestion}</p>
                              {item.config_keys?.length ? (
                                <p className="mt-1 text-[10px] text-hud-primary">{item.config_keys.join(", ")}</p>
                              ) : null}
                              {patchEntries.length > 0 && (
                                <div className="mt-2 border-t border-hud-line/30 pt-1">
                                  <div className="mb-1 flex items-center justify-between gap-2">
                                    <div className="hud-label">Patch Candidate</div>
                                    <button
                                      type="button"
                                      className={
                                        applied
                                          ? "hud-label text-hud-success"
                                          : "hud-label text-hud-primary hover:text-hud-text"
                                      }
                                      onClick={() =>
                                        handleApplyPatchCandidate(item.proposed_config_patch || {}, suggestionId)
                                      }
                                    >
                                      {applied ? "Applied To Draft" : "Review In Settings"}
                                    </button>
                                  </div>
                                  <div className="space-y-0.5">
                                    {patchEntries.slice(0, 6).map(([key, value]) => (
                                      <div key={key} className="flex justify-between gap-2 text-[10px]">
                                        <span className="text-hud-text-dim">{key}</span>
                                        <span className="text-hud-text">{String(value)}</span>
                                      </div>
                                    ))}
                                    {patchEntries.length > 6 && (
                                      <div className="text-[10px] text-hud-text-dim">
                                        +{patchEntries.length - 6} more keys
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-[10px] text-hud-text-dim">No tuning suggestions in this export yet.</p>
                    )}
                  </div>
                )}
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
                      onChange={(e) => handleChange("data_poll_interval_ms", Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Analyst Interval (ms)</label>
                    <input
                      type="number"
                      step="1000"
                      className="hud-input w-full"
                      value={localConfig.analyst_interval_ms}
                      onChange={(e) => handleChange("analyst_interval_ms", Number(e.target.value))}
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
                      onChange={(e) => handleChange("premarket_plan_window_minutes", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Generate a plan when within N minutes of the next market open.
                    </p>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Market Open Execute Window (min)</label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      className="hud-input w-full"
                      value={localConfig.market_open_execute_window_minutes ?? 2}
                      onChange={(e) => handleChange("market_open_execute_window_minutes", Number(e.target.value))}
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Execute the plan if the market is open and within this window.
                    </p>
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
                      onChange={(e) => handleChange("starting_equity", Number(e.target.value))}
                    />
                    <p className="text-xs text-hud-text-dim mt-1">For P&amp;L calculation</p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Discord Notifications</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="hud-label block mb-1" htmlFor="discord-webhook-url">
                      Webhook URL
                    </label>
                    <input
                      id="discord-webhook-url"
                      type="password"
                      className="hud-input w-full font-mono"
                      value={localConfig.discord_webhook_url || ""}
                      onChange={(e) => handleChange("discord_webhook_url", e.target.value)}
                      placeholder="https://discord.com/api/webhooks/..."
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Stored in remote agent config. Leave blank to use the Worker secret.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        className="hud-button"
                        onClick={handleTestDiscord}
                        disabled={testingDiscord}
                      >
                        {testingDiscord ? "Testing..." : "Send Test Notification"}
                      </button>
                      {discordTestMessage && <span className="hud-label text-hud-success">{discordTestMessage}</span>}
                      {discordTestError && <span className="hud-label text-hud-warning">{discordTestError}</span>}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        className="hud-input w-4 h-4"
                        checked={localConfig.discord_daily_report_enabled ?? false}
                        onChange={(e) => handleChange("discord_daily_report_enabled", e.target.checked)}
                      />
                      <span className="hud-label">Enable Daily Discord Report</span>
                    </label>
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Report Time</label>
                    <input
                      type="time"
                      className="hud-input w-full"
                      value={localConfig.discord_daily_report_time || "21:00"}
                      onChange={(e) => handleChange("discord_daily_report_time", e.target.value)}
                      disabled={!localConfig.discord_daily_report_enabled}
                    />
                  </div>
                  <div>
                    <label className="hud-label block mb-1">Time Zone</label>
                    <input
                      type="text"
                      className="hud-input w-full"
                      value={localConfig.discord_daily_report_timezone || "UTC"}
                      onChange={(e) => handleChange("discord_daily_report_timezone", e.target.value)}
                      disabled={!localConfig.discord_daily_report_enabled}
                      placeholder="Asia/Tokyo"
                    />
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Twitter/X Source</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <CookieAccountsEditor
                      idPrefix="twitter-cookies"
                      sourceLabel="Twitter/X"
                      accounts={localConfig.twitter_cookie_accounts}
                      legacyCookies={localConfig.twitter_cookies}
                      placeholder="auth_token=...; ct0=..."
                      onAdd={handleAddTwitterCookieAccount}
                      onChange={handleTwitterCookieAccountChange}
                      onRemove={handleRemoveTwitterCookieAccount}
                    />
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        className="hud-button"
                        onClick={handleTestTwitter}
                        disabled={testingTwitter}
                      >
                        {testingTwitter ? "Testing..." : "Test X Cookie"}
                      </button>
                      {twitterTestMessage && <span className="hud-label text-hud-success">{twitterTestMessage}</span>}
                      {twitterTestError && <span className="hud-label text-hud-warning">{twitterTestError}</span>}
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Alpha Vantage Source</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="hud-label block mb-1" htmlFor="alpha-vantage-api-key">
                      API Key
                    </label>
                    <input
                      id="alpha-vantage-api-key"
                      type="password"
                      className="hud-input w-full font-mono text-[10px]"
                      value={localConfig.alpha_vantage_api_key || ""}
                      onChange={(e) => handleChange("alpha_vantage_api_key", e.target.value)}
                      placeholder="Alpha Vantage API key"
                    />
                    <p className="text-[9px] text-hud-text-dim mt-1">
                      Used for news sentiment catalyst signals. Leave blank to use the Worker secret or disable this
                      source.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h3 className="hud-label mb-3 text-hud-primary">Reddit Source</h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div className="md:col-span-2">
                    <label className="hud-label block mb-1" htmlFor="reddit-user-agent">
                      User Agent
                    </label>
                    <input
                      id="reddit-user-agent"
                      type="text"
                      className="hud-input w-full font-mono text-[10px]"
                      value={localConfig.reddit_user_agent || ""}
                      onChange={(e) => handleChange("reddit_user_agent", e.target.value)}
                      placeholder="Mozilla/5.0 ..."
                    />
                  </div>
                  <div className="md:col-span-2">
                    <CookieAccountsEditor
                      idPrefix="reddit-cookies"
                      sourceLabel="Reddit"
                      accounts={localConfig.reddit_cookie_accounts}
                      legacyCookies={localConfig.reddit_cookies}
                      placeholder="reddit_session=...; token_v2=..."
                      onAdd={handleAddRedditCookieAccount}
                      onChange={handleRedditCookieAccountChange}
                      onRemove={handleRemoveRedditCookieAccount}
                    />
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <button type="button" className="hud-button" onClick={handleTestReddit} disabled={testingReddit}>
                        {testingReddit ? "Testing..." : "Test Reddit Cookies"}
                      </button>
                      {redditTestMessage && <span className="hud-label text-hud-success">{redditTestMessage}</span>}
                      {redditTestError && <span className="hud-label text-hud-warning">{redditTestError}</span>}
                    </div>
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
            <button className="hud-button" onClick={handleSave} disabled={saving}>
              {saving ? "Saving..." : "Save Configuration"}
            </button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
