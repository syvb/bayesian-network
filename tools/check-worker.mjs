// Checks worker/index.js (the Gist sharing token exchange) against a fake GitHub:
// node tools/check-worker.mjs
import worker from "../worker/index.js";

const ORIGIN = "https://iter.ca";
const env = {
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
  REDIRECT_URI: "https://iter.ca/bn/",
  ALLOWED_ORIGIN: ORIGIN,
  RATE_LIMITER: { limit: async () => ({ success: true }) },
};
const verifier = "v".repeat(43);
let github; // what the fake GitHub answers
let sent; // what the Worker sent it
globalThis.fetch = async (url, init) => {
  sent = { url, body: Object.fromEntries(init.body) };
  return new Response(JSON.stringify(github), { status: 200, headers: { "Content-Type": "application/json" } });
};
const call = (body, { origin = ORIGIN, e = env, type = "application/json" } = {}) => worker.fetch(new Request("https://w.example/token", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": type },
  body: typeof body === "string" ? body : JSON.stringify(body),
}), e);

let failures = 0;
const check = (name, ok) => { if (!ok) failures++; console.log(`${ok ? "ok  " : "FAIL"} ${name}`); };

github = { access_token: "gho_token", token_type: "bearer", scope: "gist" };
let res = await call({ code: "abc123", code_verifier: verifier });
check("returns the token", res.status === 200 && (await res.json()).access_token === "gho_token");
check("token response is not cacheable", res.headers.get("Cache-Control") === "no-store");
check("CORS allows only the editor", res.headers.get("Access-Control-Allow-Origin") === ORIGIN);
check("sends the configured client, secret and callback with the verifier",
  sent.url === "https://github.com/login/oauth/access_token" && sent.body.client_id === "client-id"
  && sent.body.client_secret === "client-secret" && sent.body.redirect_uri === "https://iter.ca/bn/"
  && sent.body.code === "abc123" && sent.body.code_verifier === verifier);

github = { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." };
res = await call({ code: "abc123", code_verifier: verifier });
check("passes GitHub's error code on, not its text", res.status === 400 && JSON.stringify(await res.json()) === '{"error":"bad_verification_code"}');

sent = null;
const statuses = {
  "other origin": (await call({ code: "abc", code_verifier: verifier }, { origin: "https://evil.example" })).status,
  "missing verifier": (await call({ code: "abc" })).status,
  "invalid verifier": (await call({ code: "abc", code_verifier: "x".repeat(42) })).status,
  "form body": (await call("code=abc", { type: "application/x-www-form-urlencoded" })).status,
  "oversized body": (await call({ code: "a".repeat(2000), code_verifier: verifier })).status,
  "rate limited": (await call({ code: "abc", code_verifier: verifier }, { e: { ...env, RATE_LIMITER: { limit: async () => ({ success: false }) } } })).status,
  "no secret configured": (await call({ code: "abc", code_verifier: verifier }, { e: { ...env, GITHUB_CLIENT_SECRET: "" } })).status,
};
const expected = { "other origin": 403, "missing verifier": 400, "invalid verifier": 400, "form body": 415, "oversized body": 413, "rate limited": 429, "no secret configured": 500 };
for (const [k, v] of Object.entries(statuses)) check(`${k} → ${expected[k]}`, v === expected[k]);
check("rejected requests never reach GitHub", sent === null);

if (failures) { console.log(`${failures} failed`); process.exit(1); }
