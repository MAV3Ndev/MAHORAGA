import type { AgentConfig } from "../schemas/agent-config";

export type AgentConfigUpdate = Partial<Omit<AgentConfig, "llm_provider">> & {
  llm_provider?: AgentConfig["llm_provider"];
};

export interface BuildAgentConfigUpdateCandidateParams {
  currentConfig: AgentConfig;
  update: AgentConfigUpdate;
  envOpenaiBaseUrl?: string;
  envAnthropicBaseUrl?: string;
}

function hasOwnKey<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}

export function normalizeAgentConfigUpdate(update: AgentConfigUpdate): Partial<AgentConfig> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) {
      normalized[key] = value;
    }
  }

  if (typeof update.openai_base_url === "string") {
    normalized.openai_base_url = update.openai_base_url.trim();
  }

  if (typeof update.anthropic_base_url === "string") {
    normalized.anthropic_base_url = update.anthropic_base_url.trim();
  }

  if (typeof update.llm_api_key === "string") {
    normalized.llm_api_key = update.llm_api_key.trim();
  }

  if (typeof update.discord_daily_report_time === "string") {
    normalized.discord_daily_report_time = update.discord_daily_report_time.trim();
  }

  if (typeof update.discord_daily_report_timezone === "string") {
    normalized.discord_daily_report_timezone = update.discord_daily_report_timezone.trim();
  }

  return normalized as Partial<AgentConfig>;
}

export function buildAgentConfigUpdateCandidate({
  currentConfig,
  update,
  envOpenaiBaseUrl,
  envAnthropicBaseUrl,
}: BuildAgentConfigUpdateCandidateParams): AgentConfig {
  const normalizedUpdate = normalizeAgentConfigUpdate(update);
  const merged = { ...currentConfig, ...normalizedUpdate };
  const updatedLlmModel = typeof update.llm_model === "string" ? update.llm_model.trim() : null;
  const analystModelExplicitlySet = hasOwnKey(update, "llm_analyst_model");
  const hasLlmBaseUrl = !!(
    merged.openai_base_url?.trim() ||
    envOpenaiBaseUrl ||
    merged.anthropic_base_url?.trim() ||
    envAnthropicBaseUrl
  );
  const shouldSyncAnalystModel =
    !!updatedLlmModel &&
    !analystModelExplicitlySet &&
    (currentConfig.llm_analyst_model === currentConfig.llm_model ||
      (hasLlmBaseUrl && ["gpt-4o", "gpt-4o-mini"].includes(currentConfig.llm_analyst_model)));

  if (shouldSyncAnalystModel) {
    merged.llm_analyst_model = updatedLlmModel;
  }

  return merged;
}
