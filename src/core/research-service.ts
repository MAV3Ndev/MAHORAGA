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
    const maxTokens = prompt.maxTokens || defaultMaxTokens;
    const request: CompletionParams = {
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
      max_tokens: maxTokens,
      temperature,
      response_format: { type: "json_object" },
    };
    const { response, model } = await this.completeWithFallback(request, preferredModel, fallbackModel, logAgent);

    this.trackUsage(model, response);

    try {
      return {
        analysis: parseLlmJsonObject<T>(response.content || "{}"),
        model,
      };
    } catch (error) {
      const retryMaxTokens = Math.max(maxTokens * 3, 1200);
      this.deps.log(logAgent, "json_parse_retry", {
        model,
        max_tokens: maxTokens,
        retry_max_tokens: retryMaxTokens,
        reason: String(error),
      });

      const retryResponse = await this.completeOnce(
        {
          ...request,
          max_tokens: retryMaxTokens,
        },
        model
      );
      this.trackUsage(model, retryResponse);

      return {
        analysis: parseLlmJsonObject<T>(retryResponse.content || "{}"),
        model,
      };
    }
  }

  private trackUsage(model: string, response: Awaited<ReturnType<LLMProvider["complete"]>>): void {
    if (response.usage) {
      this.deps.trackLLMCost(model, response.usage.prompt_tokens, response.usage.completion_tokens);
    }
  }

  private async completeWithFallback(
    request: CompletionParams,
    preferredModel: string,
    fallbackModel: string | undefined,
    logAgent: string
  ) {
    try {
      const response = await this.completeOnce(request, preferredModel);
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

      const response = await this.completeOnce(request, fallbackModel);
      return { response, model: fallbackModel };
    }
  }

  private async completeOnce(request: CompletionParams, model: string) {
    const llm = this.deps.getLlm();
    if (!llm) {
      throw new Error("LLM provider not initialized");
    }

    return llm.complete({
      ...request,
      model,
    });
  }
}
