import { createError, ErrorCode } from "../../lib/errors";
import type { CompletionParams, CompletionResult, LLMProvider } from "../types";
import { getKimiCodingHeaders } from "./openai-compatible";

export interface KimiCodingConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

interface KimiCodingResponse {
  content?: Array<{
    type?: string;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class KimiCodingProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(config: KimiCodingConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "kimi-for-code";
    this.baseUrl = (config.baseUrl ?? "https://api.kimi.com/coding/v1").trim().replace(/\/+$/, "");
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "anthropic-version": "2023-06-01",
        ...getKimiCodingHeaders(),
      },
      body: JSON.stringify({
        model: params.model ?? this.model,
        max_tokens: params.max_tokens ?? 1024,
        messages: params.messages,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw createError(ErrorCode.PROVIDER_ERROR, `Kimi Coding API error (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as KimiCodingResponse;
    const content = (data.content ?? [])
      .map((part) => (part.type === "text" || part.type === undefined ? part.text || "" : ""))
      .join("");
    const promptTokens = data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? 0;
    const completionTokens = data.usage?.output_tokens ?? data.usage?.completion_tokens ?? 0;

    return {
      content,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: data.usage?.total_tokens ?? promptTokens + completionTokens,
      },
    };
  }
}

export function createKimiCodingProvider(config: KimiCodingConfig): KimiCodingProvider {
  return new KimiCodingProvider(config);
}
