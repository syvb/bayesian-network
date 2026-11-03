# Gist sharing: GitHub App token Worker

The editor's **Share ▾ › Publish to GitHub Gist** signs the user in with GitHub, creates a secret
gist holding the network's pyAgrum export, and gives them an editor link
(`?src=<revision-specific raw URL>`). The browser talks to GitHub directly. This Worker does the
one thing a static page can't: exchange the sign-in code (with the PKCE verifier) for a token, which
needs the GitHub App's client secret. It stores nothing, logs nothing and proxies no uploads.

Until `clientId` and `tokenUrl` are set in `js/gist.js`, the feature is off and the toolbar shows
the plain **Copy link** button.

## Flow

1. The editor saves `{state, PKCE verifier, the export}` in the tab's `sessionStorage` (never in
   OAuth parameters) and sends the user to `github.com/login/oauth/authorize` with
   `state`, an S256 `code_challenge` and `scope=offline_access`. A GitHub App's permissions come
   from its settings, not scopes; `offline_access` forces an expiring token.
2. GitHub redirects back to `https://iter.ca/bn/?code=…&state=…`. The editor checks `state`
   (single use, 10-minute limit) and removes the parameters from the address bar.
3. The editor POSTs `{code, code_verifier}` to this Worker's `/token`. The Worker adds the client
   ID, secret and callback URL from its configuration and asks GitHub for the token. It refuses
   tokens without an expiry and drops the refresh token, so the browser only ever gets a token
   that dies within 8 hours.
4. The editor keeps the token in memory only (gone on reload), creates the gist with
   `POST https://api.github.com/gists` (`public: false`) and builds the link from the gist's
   revision-specific `raw_url`, so the link is an immutable snapshot.

The Gists permission is account-wide: GitHub has nothing narrower, so a token that can create a
gist can also edit or delete the user's other gists. The share dialog says so, and says that
secret gists are unlisted, not private. A GitHub App is used rather than an OAuth App because its
tokens expire after 8 hours; OAuth App tokens last until revoked or unused for a year. The user's
authorization of the app stays until they remove it; only the tokens expire.

## Setup

1. **GitHub App** (GitHub › Settings › Developer settings › GitHub Apps › New GitHub App):
   - Homepage URL: `https://iter.ca/bn/`
   - Callback URL: `https://iter.ca/bn/` (exactly; it must match `REDIRECT_URI` and
     `redirectUri` in `js/gist.js`)
   - Leave "Expire user authorization tokens" checked, and "Request user authorization (OAuth)
     during installation" and "Enable Device Flow" unchecked.
   - Webhook: uncheck Active.
   - Permissions: no repository or organization permissions; under Account permissions set
     **Gists** to Read and write, and nothing else.
   - "Where can this GitHub App be installed?": Any account. Users only authorize it when they
     sign in; they never install it.
   - After creating it, note the **Client ID** (starts with `Iv`, not the numeric App ID) and
     generate a **client secret**. No private key is needed.
2. **Worker configuration** (`wrangler.toml`): set `GITHUB_CLIENT_ID` to the GitHub App's client ID.
   `REDIRECT_URI` and `ALLOWED_ORIGIN` are already set for iter.ca. Pick another
   `namespace_id` for the rate limiter if 41001 is taken in the Cloudflare account.
3. **Secret and deploy**, from this directory, with a Cloudflare account:
   ```sh
   npx wrangler login
   npx wrangler secret put GITHUB_CLIENT_SECRET   # paste the secret at the prompt
   npx wrangler deploy
   ```
   `wrangler deploy` prints the Worker's URL, e.g. `https://bn-editor-oauth.<account>.workers.dev`.
4. **Editor configuration** (`js/gist.js`): set `clientId` to the client ID and `tokenUrl` to
   `<Worker URL>/token`, then push to deploy the site.

To cut off sign-ins, delete the app's client secret (or the app). Users can remove their own
authorization under GitHub › Settings › Applications › Authorized GitHub Apps.

## What the Worker enforces

- Only `POST /token` (and its CORS preflight) from exactly `ALLOWED_ORIGIN`; anything else is
  403/404/405.
- `Content-Type: application/json`, a body of at most 1 KB, a `code` of word characters and a
  43–128 character RFC 7636 `code_verifier`; anything else is rejected before GitHub is called.
- 10 token requests per minute per IP (Cloudflare's rate limiting binding); then 429.
- `Cache-Control: no-store` on every response. GitHub's errors are passed on as their short error
  code only. Workers Logs are turned off in `wrangler.toml`, and the code logs nothing.

## Testing

`node tools/check-worker.mjs` runs the Worker against a fake GitHub (expiring token success, refresh token dropped,
non-expiring token refused, OAuth error,
CORS, validation, size limit, rate limit, missing configuration). For a local run:
`npx wrangler dev --var ALLOWED_ORIGIN:http://127.0.0.1:<port> --var GITHUB_CLIENT_ID:<id>` with
`GITHUB_CLIENT_SECRET` in a `.dev.vars` file (git-ignored).
