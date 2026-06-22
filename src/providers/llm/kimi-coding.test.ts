import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildHttpProxyRequest, createKimiCodingProvider, KimiCodingProvider, parseHttpProxy } from "./kimi-coding";

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

  it("parses user-pass-host-port proxy format", () => {
    expect(parseHttpProxy("user:pass:proxy.example.com:8080")).toEqual({
      authorization: "Basic dXNlcjpwYXNz",
      hostname: "proxy.example.com",
      port: 8080,
    });
  });

  it("parses http proxy URL format", () => {
    expect(parseHttpProxy("http://user:pass@proxy.example.com:8080")).toEqual({
      authorization: "Basic dXNlcjpwYXNz",
      hostname: "proxy.example.com",
      port: 8080,
    });
  });

  it("builds an absolute-form HTTP proxy request", () => {
    const request = buildHttpProxyRequest(
      new URL("https://api.kimi.com/coding/v1/messages"),
      parseHttpProxy("user:pass:proxy.example.com:8080"),
      {
        method: "POST",
        headers: {
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        },
        body: '{"model":"kimi-for-code"}',
      }
    );

    expect(request).toContain("POST https://api.kimi.com/coding/v1/messages HTTP/1.1\r\n");
    expect(request).toContain("Host: api.kimi.com\r\n");
    expect(request).toContain("Proxy-Authorization: Basic dXNlcjpwYXNz\r\n");
    expect(request).toContain("Authorization: Bearer sk-test\r\n");
    expect(request).toContain("Content-Length: 25\r\n");
  });
});
