import { describe, expect, it } from "vitest";
import { bearerTokenMatches, constantTimeCompare, jsonAuthResponse } from "./auth";

function requestWithAuth(value?: string): Request {
  return new Request("https://example.test", {
    headers: value ? { Authorization: value } : undefined,
  });
}

describe("auth helpers", () => {
  it("compares equal strings without accepting different lengths", () => {
    expect(constantTimeCompare("secret", "secret")).toBe(true);
    expect(constantTimeCompare("secret", "Secret")).toBe(false);
    expect(constantTimeCompare("secret", "secret-extra")).toBe(false);
  });

  it("matches bearer tokens exactly", () => {
    expect(bearerTokenMatches(requestWithAuth("Bearer token-123"), "token-123")).toBe(true);
    expect(bearerTokenMatches(requestWithAuth("Bearer token-1234"), "token-123")).toBe(false);
    expect(bearerTokenMatches(requestWithAuth("Basic token-123"), "token-123")).toBe(false);
    expect(bearerTokenMatches(requestWithAuth(), "token-123")).toBe(false);
    expect(bearerTokenMatches(requestWithAuth("Bearer token-123"), undefined)).toBe(false);
  });

  it("builds JSON auth responses", async () => {
    const response = jsonAuthResponse("Forbidden", 403);

    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });
});
