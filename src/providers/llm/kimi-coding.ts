import { createError, ErrorCode } from "../../lib/errors";
import type { CompletionParams, CompletionResult, LLMProvider } from "../types";
import { getKimiCodingHeaders } from "./openai-compatible";

const MAX_PROXY_RESPONSE_BYTES = 2 * 1024 * 1024;
const SOCKET_TIMEOUT_MS = 30_000;

export interface KimiCodingConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  httpProxy?: string;
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
  private httpProxy: string | null;

  constructor(config: KimiCodingConfig) {
    this.apiKey = config.apiKey ?? "";
    this.model = config.model ?? "kimi-for-code";
    this.baseUrl = (config.baseUrl ?? "https://api.kimi.com/coding/v1").trim().replace(/\/+$/, "");
    this.httpProxy = config.httpProxy?.trim() || null;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const response = await this.postMessages(params);

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

  private async postMessages(params: CompletionParams): Promise<Response> {
    if (!this.apiKey) {
      throw createError(ErrorCode.INVALID_INPUT, "Kimi Coding requires ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY");
    }

    const url = `${this.baseUrl}/messages`;
    const headers = this.buildRequestHeaders();
    const body = JSON.stringify(this.buildRequestBody(params));

    if (this.httpProxy) {
      return fetchViaHttpProxy(this.httpProxy, url, {
        method: "POST",
        headers,
        body,
      });
    }

    if (this.isCloudflareWorkersRuntime() && new URL(this.baseUrl).hostname.toLowerCase() === "api.kimi.com") {
      throw createError(
        ErrorCode.PROVIDER_ERROR,
        "Kimi Coding direct fetch is blocked from Cloudflare Workers by Kimi's Cloudflare challenge. Configure kimi_coding_http_proxy or KIMI_CODING_HTTP_PROXY."
      );
    }

    return fetch(url, {
      method: "POST",
      headers,
      body,
    });
  }

  private buildRequestHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "anthropic-version": "2023-06-01",
      ...getKimiCodingHeaders(),
    };
  }

  private buildRequestBody(params: CompletionParams): Record<string, unknown> {
    return {
      model: params.model ?? this.model,
      max_tokens: params.max_tokens ?? 1024,
      messages: params.messages,
    };
  }

  private isCloudflareWorkersRuntime(): boolean {
    return typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  }
}

export function createKimiCodingProvider(config: KimiCodingConfig): KimiCodingProvider {
  return new KimiCodingProvider(config);
}

interface ParsedHttpProxy {
  hostname: string;
  port: number;
  authorization?: string;
}

interface ProxyRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function parseHttpProxy(proxy: string): ParsedHttpProxy {
  const trimmed = proxy.trim();
  if (!trimmed) {
    throw createError(ErrorCode.INVALID_INPUT, "HTTP proxy is empty");
  }

  if (trimmed.includes("://")) {
    const url = new URL(trimmed);
    if (!url.hostname || !url.port) {
      throw createError(ErrorCode.INVALID_INPUT, "Kimi Coding HTTP proxy must include host and port");
    }
    if (url.protocol !== "http:") {
      throw createError(ErrorCode.INVALID_INPUT, "Kimi Coding HTTP proxy must use http://");
    }
    return {
      hostname: url.hostname,
      port: Number(url.port),
      authorization:
        url.username || url.password
          ? `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}`
          : undefined,
    };
  }

  const parts = trimmed.split(":");
  if (parts.length === 2) {
    const [hostname, port] = parts;
    if (!hostname || !port) {
      throw createError(ErrorCode.INVALID_INPUT, "Kimi Coding HTTP proxy must include host and port");
    }
    return {
      hostname,
      port: Number(port),
    };
  }
  if (parts.length === 4) {
    const [username, password, hostname, port] = parts;
    if (!username || !password || !hostname || !port) {
      throw createError(ErrorCode.INVALID_INPUT, "Kimi Coding HTTP proxy must include user, password, host, and port");
    }
    return {
      authorization: `Basic ${btoa(`${username}:${password}`)}`,
      hostname,
      port: Number(port),
    };
  }

  throw createError(
    ErrorCode.INVALID_INPUT,
    "Kimi Coding HTTP proxy must be host:port, user:pass:host:port, or http://user:pass@host:port"
  );
}

async function fetchViaHttpProxy(proxySpec: string, targetUrl: string, init: ProxyRequestInit): Promise<Response> {
  const target = new URL(targetUrl);
  if (target.protocol !== "https:") {
    throw createError(ErrorCode.INVALID_INPUT, "Kimi Coding proxy transport only supports HTTPS targets");
  }

  const proxy = parseHttpProxy(proxySpec);
  if (!Number.isInteger(proxy.port) || proxy.port <= 0 || proxy.port > 65535) {
    throw createError(ErrorCode.INVALID_INPUT, "Kimi Coding HTTP proxy port is invalid");
  }

  const { connect } = await import("cloudflare:sockets");

  return fetchViaHttpConnectProxy(connect, proxy, target, init);
}

type SocketConnect = typeof import("cloudflare:sockets").connect;

async function fetchViaHttpConnectProxy(
  connect: SocketConnect,
  proxy: ParsedHttpProxy,
  target: URL,
  init: ProxyRequestInit
): Promise<Response> {
  const tcpSocket = connect(
    { hostname: proxy.hostname, port: proxy.port },
    { secureTransport: "starttls", allowHalfOpen: true }
  );
  let activeSocket = tcpSocket;
  try {
    await waitForSocketOpened(tcpSocket, "Kimi Coding HTTP CONNECT proxy TCP connection failed");
    await writeSocket(tcpSocket, buildHttpConnectRequest(target, proxy));

    const connectResponse = await readHttpHeadersFromSocket(tcpSocket, MAX_PROXY_RESPONSE_BYTES);
    assertConnectAccepted(connectResponse.headers);
    if (connectResponse.leftover.byteLength > 0) {
      throw createError(ErrorCode.PROVIDER_ERROR, "Kimi Coding HTTP proxy returned unexpected CONNECT body");
    }

    activeSocket = tcpSocket.startTls({ expectedServerHostname: target.hostname });
    await waitForSocketOpened(
      activeSocket,
      "Kimi Coding HTTP CONNECT proxy opened the tunnel, but Cloudflare Workers failed the Kimi TLS handshake. A standard HTTP proxy cannot move this TLS handshake out of the Worker runtime."
    );
    await writeSocket(activeSocket, buildHttpsTunnelRequest(target, init));

    const responseBytes = await readAllBytesFromSocket(activeSocket, MAX_PROXY_RESPONSE_BYTES);
    return buildResponseFromRawHttp(responseBytes);
  } finally {
    await activeSocket.close().catch(() => undefined);
  }
}

export function buildHttpConnectRequest(target: URL, proxy: ParsedHttpProxy): string {
  const authority = `${target.hostname}:${target.port || "443"}`;
  return [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    proxy.authorization ? `Proxy-Authorization: ${proxy.authorization}` : null,
    "Proxy-Connection: Keep-Alive",
    "",
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\r\n");
}

export function buildHttpsTunnelRequest(target: URL, init: ProxyRequestInit): string {
  const path = `${target.pathname}${target.search}`;
  return [
    `${init.method} ${path} HTTP/1.1`,
    `Host: ${target.host}`,
    ...Object.entries({
      ...init.headers,
      "Accept-Encoding": "identity",
      "Content-Length": String(new TextEncoder().encode(init.body).byteLength),
      Connection: "close",
    }).map(([key, value]) => `${key}: ${value}`),
    "",
    init.body,
  ]
    .filter((line): line is string => line !== null)
    .join("\r\n");
}

async function waitForSocketOpened(socket: Socket, message: string): Promise<void> {
  try {
    await socket.opened;
  } catch (error) {
    const suffix = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw createError(ErrorCode.PROVIDER_ERROR, `${message}${suffix}`);
  }
}

async function writeSocket(socket: Socket, request: string, closeWriter = false): Promise<void> {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(request));
    if (closeWriter) {
      await writer.close();
    }
  } finally {
    writer.releaseLock();
  }
}

interface SocketHeaderRead {
  headers: Uint8Array;
  leftover: Uint8Array;
}

async function readHttpHeadersFromSocket(socket: Socket, maxBytes: number): Promise<SocketHeaderRead> {
  const reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await readSocketChunk(
        socket,
        reader,
        "Kimi Coding HTTP proxy CONNECT response timed out"
      );
      if (done) {
        throw createError(ErrorCode.PROVIDER_ERROR, "Kimi Coding HTTP proxy closed before CONNECT completed");
      }
      if (!value) continue;

      const chunk = value;
      chunks.push(copyBytes(chunk));
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw createError(ErrorCode.PROVIDER_ERROR, "Kimi Coding HTTP proxy CONNECT response is too large");
      }

      const bytes = concatBytes(chunks, total);
      const headerEnd = findHeaderEnd(bytes);
      if (headerEnd < 0) continue;

      return {
        headers: copyBytes(bytes.slice(0, headerEnd)),
        leftover: copyBytes(bytes.slice(headerEnd + 4)),
      };
    }
  } finally {
    reader.releaseLock();
  }
}

function assertConnectAccepted(headers: Uint8Array): void {
  const headerText = new TextDecoder().decode(headers);
  const [statusLine] = headerText.split("\r\n");
  if (!statusLine) {
    throw createError(ErrorCode.PROVIDER_ERROR, "Kimi Coding HTTP proxy returned an invalid CONNECT status line");
  }

  const status = Number(statusLine.split(" ")[1]);
  if (status !== 200) {
    throw createError(ErrorCode.PROVIDER_ERROR, `Kimi Coding HTTP proxy CONNECT failed (${status}): ${statusLine}`);
  }
}

async function readAllBytesFromSocket(socket: Socket, maxBytes: number): Promise<Uint8Array> {
  const reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await readSocketChunk(socket, reader, "Kimi Coding HTTP proxy response timed out");
      if (done) break;
      if (!value) continue;

      const chunk = value;
      chunks.push(copyBytes(chunk));
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw createError(ErrorCode.PROVIDER_ERROR, "Kimi Coding HTTP proxy response is too large");
      }
    }
    return concatBytes(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

async function readSocketChunk(
  socket: Socket,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMessage: string
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void socket.close().catch(() => undefined);
  }, SOCKET_TIMEOUT_MS);

  try {
    const result = await reader.read();
    if (timedOut) {
      throw createError(ErrorCode.PROVIDER_ERROR, timeoutMessage);
    }
    return result;
  } catch (error) {
    if (timedOut) {
      throw createError(ErrorCode.PROVIDER_ERROR, timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildResponseFromRawHttp(bytes: Uint8Array): Response {
  const headerEnd = findHeaderEnd(bytes);
  if (headerEnd < 0) {
    throw createError(ErrorCode.PROVIDER_ERROR, "Kimi Coding HTTP proxy returned an invalid HTTP response");
  }

  const headerText = new TextDecoder().decode(bytes.slice(0, headerEnd));
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  if (!statusLine) {
    throw createError(ErrorCode.PROVIDER_ERROR, "Kimi Coding HTTP proxy returned an invalid HTTP status line");
  }
  const status = Number(statusLine.split(" ")[1]);
  if (!Number.isInteger(status)) {
    throw createError(
      ErrorCode.PROVIDER_ERROR,
      `Kimi Coding HTTP proxy returned an invalid HTTP status: ${statusLine}`
    );
  }
  const headers = new Headers();
  for (const line of headerLines) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      headers.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }

  let body: Uint8Array = copyBytes(bytes.slice(headerEnd + 4));
  if (headers.get("transfer-encoding")?.toLowerCase() === "chunked") {
    body = decodeChunkedBody(body);
    headers.delete("transfer-encoding");
  }

  return new Response(toArrayBuffer(body), { status, headers });
}

function decodeChunkedBody(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;

  while (offset < bytes.byteLength) {
    const nextLine = findLineEnd(bytes, offset);
    if (nextLine < 0) break;
    const sizeText = new TextDecoder().decode(bytes.slice(offset, nextLine)).split(";", 1)[0]?.trim() || "";
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) break;
    offset = nextLine + 2;
    if (size === 0) break;
    const chunk = bytes.slice(offset, offset + size);
    chunks.push(chunk);
    total += chunk.byteLength;
    offset += size + 2;
  }

  return concatBytes(chunks, total);
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i <= bytes.byteLength - 4; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function findLineEnd(bytes: Uint8Array, start: number): number {
  for (let i = start; i <= bytes.byteLength - 2; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) {
      return i;
    }
  }
  return -1;
}
