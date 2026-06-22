const HERMES_AGENT_HEADERS = {
  "User-Agent": "HermesAgent/1.0",
} as const;

export function getOpenAICompatibleHeaders(baseUrl: string): Record<string, string> {
  new URL(baseUrl);
  return HERMES_AGENT_HEADERS;
}
