export function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function bearerTokenMatches(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  return constantTimeCompare(authHeader.slice(7), expectedToken);
}

export function jsonAuthResponse(message: string, status: 401 | 403): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
