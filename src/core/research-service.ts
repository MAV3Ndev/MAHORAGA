import { parseLlmJsonObject } from "../lib/llm-json";
import type { CompletionParams, LLMProvider } from "../providers/types";
import type { PromptTemplate } from "../strategy/types";
import type { AgentConfig } from "./types";

export interface ResearchServiceDeps {
  getLlm: () => LLMProvider | null;
  getConfig: () => AgentConfig;
  log: (agent: string, action: string, details: Record<string, unknown>) => void;
  trackLLMCost: (model: string, tokensIn: number, tokensOut: number) => number;
}

export interface CompletePromptParams {
  prompt: PromptTemplate;
  logAgent: string;
  defaultMaxTokens: number;
  temperature: number;
}

export function isUnknownModelError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("unknown model") || message.includes('"1211"') || message.includes('code":"1211');
}

export function isRateLimitError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("rate_limit") ||
    message.includes("temporarily overloaded") ||
    message.includes("try again later")
  );
}

export class ResearchService {
  constructor(private readonly deps: ResearchServiceDeps) {}

  async completePromptJson<T>({
    prompt,
    logAgent,
    defaultMaxTokens,
    temperature,
  }: CompletePromptParams): Promise<{ analysis: T; model: string }> {
    const config = this.deps.getConfig();
    const preferredModel = prompt.model || config.llm_analyst_model || config.llm_model;
    const fallbackModel = config.llm_model;
    const { response, model } = await this.completeWithFallback(
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        max_tokens: prompt.maxTokens || defaultMaxTokens,
        temperature,
        response_format: { type: "json_object" },
      },
      preferredModel,
      fallbackModel,
      logAgent
    );

    if (response.usage) {
      this.deps.trackLLMCost(model, response.usage.prompt_tokens, response.usage.completion_tokens);
    }

    return {
      analysis: parseLlmJsonObject<T>(response.content || "{}"),
      model,
    };
  }

  private async completeWithFallback(
    request: CompletionParams,
    preferredModel: string,
    fallbackModel: string | undefined,
    logAgent: string
  ) {
    const llm = this.deps.getLlm();
    if (!llm) {
      throw new Error("LLM provider not initialized");
    }

    try {
      const response = await llm.complete({
        ...request,
        model: preferredModel,
      });
      return { response, model: preferredModel };
    } catch (error) {
      const shouldRetryWithFallback = !!fallbackModel && fallbackModel !== preferredModel && isUnknownModelError(error);

      if (!shouldRetryWithFallback) {
        throw error;
      }

      this.deps.log(logAgent, "model_fallback", {
        preferred_model: preferredModel,
        fallback_model: fallbackModel,
        reason: "unknown_model",
      });

      const response = await llm.complete({
        ...request,
        model: fallbackModel,
      });
      return { response, model: fallbackModel };
    }
  }
}
