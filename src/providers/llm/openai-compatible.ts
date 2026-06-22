const HERMES_AGENT_HEADERS = {
  "User-Agent": "HermesAgent/1.0",
} as const;

export function getOpenAICompatibleHeaders(baseUrl: string): Record<string, string> {
  new URL(baseUrl);
  return HERMES_AGENT_HEADERS;
}

export function isMiniMaxOpenAICompatibleUrl(baseUrl: string): boolean {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname === "api.minimaxi.com" || hostname === "api.minimax.chat";
}
