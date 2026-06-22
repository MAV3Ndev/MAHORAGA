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

  it("retries JSON prompts with a larger output budget when reasoning consumes the first response", async () => {
    const maxTokens: number[] = [];
    const logs: Array<{ agent: string; action: string; details: Record<string, unknown> }> = [];
    const costs: Array<{ tokensIn: number; tokensOut: number }> = [];
    const llm: LLMProvider = {
      async complete(params) {
        maxTokens.push(params.max_tokens || 0);
        if (maxTokens.length === 1) {
          return {
            content: "<think>The model used the entire first response for reasoning.</think>",
            usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
          };
        }

        return {
          content: '<think>Reasoning completed.</think>\n{"ok":true}',
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        };
      },
    };

    const service = new ResearchService({
      getLlm: () => llm,
      getConfig: () => ({ ...DEFAULT_CONFIG, llm_model: "MiniMax-M3", llm_analyst_model: "MiniMax-M3" }),
      log: (agent, action, details) => logs.push({ agent, action, details }),
      trackLLMCost: (_model, tokensIn, tokensOut) => {
        costs.push({ tokensIn, tokensOut });
        return 0;
      },
    });

    const result = await service.completePromptJson<{ ok: boolean }>({
      prompt: { system: "system", user: "user", model: "MiniMax-M3", maxTokens: 400 },
      logAgent: "SignalResearch",
      defaultMaxTokens: 100,
      temperature: 0.3,
    });

    expect(result).toEqual({ analysis: { ok: true }, model: "MiniMax-M3" });
    expect(maxTokens).toEqual([400, 1200]);
    expect(costs).toEqual([
      { tokensIn: 10, tokensOut: 100 },
      { tokensIn: 10, tokensOut: 20 },
    ]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      agent: "SignalResearch",
      action: "json_parse_retry",
      details: { model: "MiniMax-M3", max_tokens: 400, retry_max_tokens: 1200 },
    });
  });

  it("identifies transient LLM error categories", () => {
    expect(isUnknownModelError(new Error('{"code":"1211"}'))).toBe(true);
    expect(isRateLimitError(new Error("429 rate_limit"))).toBe(true);
  });
});
