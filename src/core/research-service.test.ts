import { describe, expect, it } from "vitest";
import type { LLMProvider } from "../providers/types";
import { DEFAULT_CONFIG } from "../strategy/default/config";
import { isRateLimitError, isUnknownModelError, ResearchService } from "./research-service";

describe("research service", () => {
  it("falls back to the base model on unknown model errors", async () => {
    const calls: string[] = [];
    const logs: Array<Record<string, unknown>> = [];
    const llm: LLMProvider = {
      async complete(params) {
        calls.push(params.model || "");
        if (params.model === "bad-model") {
          throw new Error("Unknown model code: 1211");
        }

        return {
          content: '{"ok":true}',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        };
      },
    };

    const service = new ResearchService({
      getLlm: () => llm,
      getConfig: () => ({ ...DEFAULT_CONFIG, llm_model: "fallback-model" }),
      log: (_agent, _action, details) => logs.push(details),
      trackLLMCost: () => 0,
    });

    const result = await service.completePromptJson<{ ok: boolean }>({
      prompt: { system: "system", user: "user", model: "bad-model" },
      logAgent: "Test",
      defaultMaxTokens: 100,
      temperature: 0.3,
    });

    expect(calls).toEqual(["bad-model", "fallback-model"]);
    expect(logs).toEqual([{ preferred_model: "bad-model", fallback_model: "fallback-model", reason: "unknown_model" }]);
    expect(result).toEqual({ analysis: { ok: true }, model: "fallback-model" });
  });

  it("identifies transient LLM error categories", () => {
    expect(isUnknownModelError(new Error('{"code":"1211"}'))).toBe(true);
    expect(isRateLimitError(new Error("429 rate_limit"))).toBe(true);
  });
});
