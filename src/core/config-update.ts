import type { AgentConfig } from "../schemas/agent-config";

export type AgentConfigUpdate = Partial<Omit<AgentConfig, "llm_provider">> & {
  llm_provider?: AgentConfig["llm_provider"] | "openai-compatible";
};

export interface BuildAgentConfigUpdateCandidateParams {
  currentConfig: AgentConfig;
  update: AgentConfigUpdate;
  envOpenaiBaseUrl?: string;
}

function hasOwnKey<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function normalizeAgentConfigUpdate(update: AgentConfigUpdate): Partial<AgentConfig> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) {
      normalized[key] = value;
    }
  }

  if (update.llm_provider !== undefined) {
    normalized.llm_provider = update.llm_provider === "openai-compatible" ? "openai-raw" : update.llm_provider;
  }

  if (typeof update.openai_base_url === "string") {
    normalized.openai_base_url = update.openai_base_url.trim();
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
}: BuildAgentConfigUpdateCandidateParams): AgentConfig {
  const normalizedUpdate = normalizeAgentConfigUpdate(update);
  const merged = { ...currentConfig, ...normalizedUpdate };
  const updatedLlmModel = typeof update.llm_model === "string" ? update.llm_model.trim() : null;
  const analystModelExplicitlySet = hasOwnKey(update, "llm_analyst_model");
  const hasOpenaiBaseUrl = !!(merged.openai_base_url?.trim() || envOpenaiBaseUrl);
  const shouldSyncAnalystModel =
    !!updatedLlmModel &&
    !analystModelExplicitlySet &&
    (currentConfig.llm_analyst_model === currentConfig.llm_model ||
      (hasOpenaiBaseUrl && ["gpt-4o", "gpt-4o-mini"].includes(currentConfig.llm_analyst_model)));

  if (shouldSyncAnalystModel) {
    merged.llm_analyst_model = updatedLlmModel;
  }

  return merged;
}
