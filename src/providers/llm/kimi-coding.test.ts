import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKimiCodingProvider, KimiCodingProvider } from "./kimi-coding";

describe("Kimi Coding Provider", () => {
  const mockFetch = vi.fn();
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("creates provider with required config", () => {
    const provider = createKimiCodingProvider({ apiKey: "sk-test" });
    expect(provider).toBeInstanceOf(KimiCodingProvider);
  });

  it("sends Anthropic Messages request to Kimi Coding", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    });

    const provider = createKimiCodingProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.kimi.com/coding/v1/",
    });
    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(mockFetch).toHaveBeenCalledWith("https://api.kimi.com/coding/v1/messages", expect.any(Object));
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(options.method).toBe("POST");
    expect(options.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
      "User-Agent": "claude-code/0.1.0",
      "anthropic-version": "2023-06-01",
    });
    expect(JSON.parse(options.body as string)).toEqual({
      model: "kimi-for-code",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result).toEqual({
      content: "ok",
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        total_tokens: 12,
      },
    });
  });

  it("accepts Kimi responses with empty Anthropic envelope fields", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: "",
        role: "",
        content: [{ type: "text", text: "" }],
        usage: { input_tokens: 8, output_tokens: 1 },
      }),
    });

    const provider = createKimiCodingProvider({ apiKey: "sk-test" });
    const result = await provider.complete({
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("");
    expect(result.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 1,
      total_tokens: 9,
    });
  });
});
