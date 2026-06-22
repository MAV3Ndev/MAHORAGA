import { getOpenAICompatibleHeaders } from "./openai-compatible";

const RESPONSE_SNIPPET_BYTES = 4096;

export type LLMProbeProtocol = "openai-chat" | "anthropic-messages";

export interface LLMEndpointProbe {
  name: string;
  baseUrl: string;
  path: string;
  model: string;
  apiKey?: string;
  protocol: LLMProbeProtocol;
}

export interface LLMEndpointProbeResult {
  name: string;
  url: string;
  ok: boolean;
  status: number;
  statusText: string;
  responseHeaders: {
    contentType: string | null;
    server: string | null;
    cfRay: string | null;
  };
  bodySnippet: string;
  challengeDetected: boolean;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function buildProbeUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}/${path.replace(/^\/+/, "")}`;
}

function buildProbeBody(protocol: LLMProbeProtocol, model: string): string {
  if (protocol === "anthropic-messages") {
    return JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    });
  }

  return JSON.stringify({
    model,
    max_tokens: 1,
    temperature: 0,
    messages: [{ role: "user", content: "hi" }],
  });
}

function buildProbeHeaders(probe: LLMEndpointProbe): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${probe.apiKey || "probe"}`,
    ...getOpenAICompatibleHeaders(probe.baseUrl),
  };

  if (probe.protocol === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
  }

  return headers;
}

async function readResponseSnippet(response: Response): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < RESPONSE_SNIPPET_BYTES) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }

      const remaining = RESPONSE_SNIPPET_BYTES - bytesRead;
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
      chunks.push(chunk);
      bytesRead += chunk.byteLength;

      if (value.byteLength > remaining) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function isCloudflareChallenge(response: Response, bodySnippet: string): boolean {
  const body = bodySnippet.toLowerCase();
  const server = response.headers.get("server")?.toLowerCase() || "";
  return (
    response.status === 403 &&
    (server.includes("cloudflare") ||
      body.includes("attention required") ||
      body.includes("cf-browser-verification") ||
      body.includes("/cdn-cgi/challenge-platform/"))
  );
}

export async function probeLLMEndpoint(probe: LLMEndpointProbe): Promise<LLMEndpointProbeResult> {
  const url = buildProbeUrl(probe.baseUrl, probe.path);
  const response = await fetch(url, {
    method: "POST",
    headers: buildProbeHeaders(probe),
    body: buildProbeBody(probe.protocol, probe.model),
  });
  const bodySnippet = await readResponseSnippet(response);

  return {
    name: probe.name,
    url,
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    responseHeaders: {
      contentType: response.headers.get("content-type"),
      server: response.headers.get("server"),
      cfRay: response.headers.get("cf-ray"),
    },
    bodySnippet,
    challengeDetected: isCloudflareChallenge(response, bodySnippet),
  };
}

export function getKimiCodingBaseUrl(baseUrl: string): string | null {
  const url = new URL(baseUrl);
  if (url.hostname.toLowerCase() !== "api.kimi.com") {
    return null;
  }

  const codingIndex = url.pathname.split("/").indexOf("coding");
  if (codingIndex < 0) {
    return null;
  }

  url.pathname = `${url.pathname
    .split("/")
    .slice(0, codingIndex + 1)
    .join("/")}`;
  url.search = "";
  url.hash = "";
  return normalizeBaseUrl(url.toString());
}
