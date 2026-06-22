const HERMES_AGENT_HEADERS = {
  "User-Agent": "HermesAgent/1.0",
} as const;

const KIMI_CODING_HEADERS = {
  "User-Agent": "claude-code/0.1.0",
} as const;

export function getKimiCodingHeaders(): Record<string, string> {
  return KIMI_CODING_HEADERS;
}

export function getOpenAICompatibleHeaders(baseUrl: string): Record<string, string> {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (hostname === "api.kimi.com") {
    return KIMI_CODING_HEADERS;
  }

  return HERMES_AGENT_HEADERS;
}
