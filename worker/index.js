// Swaps a GitHub App sign-in code for a user token, for the BN Editor's "Publish to GitHub Gist".
//
// GitHub's token endpoint needs the GitHub App's client secret and doesn't allow cross-origin
// requests, so the editor (a static page) can't call it itself. This Worker is the only server
// in the flow: it stores nothing, logs nothing, and returns the token to the editor, which
// creates the gist directly with GitHub. Setup: README.md in this directory.
//
// POST /token  {"code": "...", "code_verifier": "..."}  ->  {"access_token", "token_type", "expires_in"}
//
// Only tokens that expire (8 hours) are handed out. GitHub's refresh token, which could renew
// one for 6 months, is dropped here and never reaches the browser.

const MAX_BODY = 1024; // bytes; a real request is about 120
const CODE = /^[\w.-]{1,256}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636 section 4.1

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    const allowed = !!env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN;
    const headers = { Vary: "Origin", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (allowed) headers["Access-Control-Allow-Origin"] = origin;
    const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), {
      status,
      headers: { ...headers, "Content-Type": "application/json", ...extra },
    });

    if (new URL(request.url).pathname !== "/token") return reply(404, { error: "not_found" });
    if (!allowed) return reply(403, { error: "origin_not_allowed" });
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...headers, "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" },
      });
    }
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, { Allow: "POST, OPTIONS" });
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET || !env.REDIRECT_URI || !env.RATE_LIMITER) {
      return reply(500, { error: "not_configured" });
    }
    const { success } = await env.RATE_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
    if (!success) return reply(429, { error: "rate_limited" }, { "Retry-After": "60" });

    if (!/^application\/json\s*(;|$)/i.test(request.headers.get("Content-Type") || "")) {
      return reply(415, { error: "expected_json" });
    }
    if (+(request.headers.get("Content-Length") || 0) > MAX_BODY) return reply(413, { error: "body_too_large" });
    const text = await readText(request, MAX_BODY);
    if (text === null) return reply(413, { error: "body_too_large" });
    let body;
    try { body = JSON.parse(text); } catch { return reply(400, { error: "invalid_json" }); }
    if (!body || typeof body !== "object" || typeof body.code !== "string" || !CODE.test(body.code)
      || typeof body.code_verifier !== "string" || !VERIFIER.test(body.code_verifier)) {
      return reply(400, { error: "invalid_request" });
    }

    let res;
    try {
      res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "bn-editor-oauth" },
        body: new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code: body.code,
          code_verifier: body.code_verifier,
          redirect_uri: env.REDIRECT_URI,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return reply(502, { error: "github_unreachable" });
    }
    const data = res.ok ? await res.json().catch(() => null) : null;
    if (!data) return reply(502, { error: "github_error" });
    // GitHub reports a bad or expired code as 200 with an error field.
    if (data.error) return reply(400, { error: /^[a-z_]{1,64}$/.test(data.error) ? data.error : "oauth_error" });
    if (typeof data.access_token !== "string") return reply(502, { error: "github_error" });
    // The editor asks for offline_access, so a token without an expiry means the client ID isn't
    // a GitHub App's. Refuse rather than hand out a token that never expires.
    if (!(data.expires_in > 0)) return reply(502, { error: "token_does_not_expire" });
    return reply(200, { access_token: data.access_token, token_type: data.token_type, expires_in: data.expires_in }, { Pragma: "no-cache" });
  },
};

// The body as text, or null if it's longer than `max` bytes.
async function readText(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(bytes);
}
