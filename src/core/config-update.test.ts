import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../strategy/default/config";
import { buildAgentConfigUpdateCandidate, normalizeAgentConfigUpdate } from "./config-update";

describe("config update", () => {
  it("normalizes dashboard string fields", () => {
    expect(
      normalizeAgentConfigUpdate({
        llm_provider: "openai-raw",
        llm_api_key: "  sk-test  ",
        openai_base_url: "  https://example.test/v1  ",
        anthropic_base_url: "  https://anthropic.example.test  ",
        discord_daily_report_time: " 21:30 ",
        discord_daily_report_timezone: " Asia/Tokyo ",
      })
    ).toMatchObject({
      llm_provider: "openai-raw",
      llm_api_key: "sk-test",
      openai_base_url: "https://example.test/v1",
      anthropic_base_url: "https://anthropic.example.test",
      discord_daily_report_time: "21:30",
      discord_daily_report_timezone: "Asia/Tokyo",
    });
  });

  it("does not overwrite current config with omitted update fields", () => {
    const candidate = buildAgentConfigUpdateCandidate({
      currentConfig: DEFAULT_CONFIG,
      update: { max_positions: 7 },
    });

    expect(candidate.max_positions).toBe(7);
    expect(candidate.llm_provider).toBe(DEFAULT_CONFIG.llm_provider);
    expect(candidate.openai_base_url).toBe(DEFAULT_CONFIG.openai_base_url);
  });

  it("syncs analyst model when the primary model changes and analyst model was implicit", () => {
    const candidate = buildAgentConfigUpdateCandidate({
      currentConfig: {
        ...DEFAULT_CONFIG,
        llm_model: "gpt-4o",
        llm_analyst_model: "gpt-4o",
      },
      update: { llm_model: "gpt-5.4" },
    });

    expect(candidate.llm_model).toBe("gpt-5.4");
    expect(candidate.llm_analyst_model).toBe("gpt-5.4");
  });

  it("keeps an explicitly updated analyst model separate from the primary model", () => {
    const candidate = buildAgentConfigUpdateCandidate({
      currentConfig: {
        ...DEFAULT_CONFIG,
        llm_model: "gpt-4o",
        llm_analyst_model: "gpt-4o",
      },
      update: { llm_model: "gpt-5.4", llm_analyst_model: "gpt-5.4-mini" },
    });

    expect(candidate.llm_model).toBe("gpt-5.4");
    expect(candidate.llm_analyst_model).toBe("gpt-5.4-mini");
  });

  it("syncs OpenAI analyst defaults when a base URL is configured", () => {
    const candidate = buildAgentConfigUpdateCandidate({
      currentConfig: {
        ...DEFAULT_CONFIG,
        llm_model: "custom/current",
        llm_analyst_model: "gpt-4o-mini",
        openai_base_url: "",
      },
      update: { llm_model: "custom/next" },
      envOpenaiBaseUrl: "https://gateway.example.test/v1",
    });

    expect(candidate.llm_analyst_model).toBe("custom/next");
  });
});
