// Sharing through GitHub gists: sign in with GitHub (a GitHub App's user sign-in, with PKCE),
// create a secret gist
// holding the network's pyAgrum export, and link to its revision-specific raw file with ?src=.
//
// The only server involved is a small Cloudflare Worker (worker/) that swaps the OAuth code for a
// token, because GitHub's token endpoint needs the app's client secret and doesn't allow
// cross-origin requests. The gist itself is created straight from the browser. The token is kept
// in this module's memory only, so it's gone when the tab closes or reloads, and it expires on
// GitHub after 8 hours. Its refresh token never leaves the Worker.
"use strict";

const BNGist = (() => {
  // Leave clientId or tokenUrl empty to turn Gist sharing off. See worker/README.md for setup.
  const config = {
    clientId: "", // the GitHub App's client ID (public; starts with Iv)
    tokenUrl: "", // the Worker's token endpoint, e.g. https://bn-editor-oauth.<account>.workers.dev/token
    redirectUri: "https://iter.ca/bn/", // the GitHub App's callback URL: this page
  };

  const PENDING_KEY = "bn-editor-gist-pending";
  const PENDING_MAX_AGE = 10 * 60 * 1000; // GitHub's OAuth codes last 10 minutes too
  const OAUTH_PARAMS = ["code", "state", "error", "error_description", "error_uri"];

  let token = null;

  const pageBase = () => location.href.replace(/[?#].*$/, "");
  // The sign-in returns to config.redirectUri, so it only works on that page.
  const available = () => !!(config.clientId && config.tokenUrl) && pageBase() === config.redirectUri;

  const base64Url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const randomString = () => base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeFor = async (verifier) => base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));

  class ShareError extends Error {}

  // Leaves for GitHub's sign-in page. `share` ({code, filename, description}) is kept in this tab's
  // sessionStorage, not in the OAuth parameters, and published when GitHub sends the user back.
  async function signInAndShare(share) {
    const state = randomString();
    const verifier = randomString();
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, share, at: Date.now() }));
    const url = new URL("https://github.com/login/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      // GitHub Apps get their permissions (here just Gists) from the app's settings, not from
      // scopes. offline_access is the one scope they take: it makes the token expire in 8 hours
      // even if the app's token expiration setting is off.
      scope: "offline_access",
      state,
      code_challenge: await challengeFor(verifier),
      code_challenge_method: "S256",
      allow_signup: "false",
    });
    location.assign(url.href);
  }

  // Handles GitHub's redirect back to this page, if this is one. Removes the OAuth parameters from
  // the address bar either way. Returns null when this isn't an OAuth redirect, otherwise
  // {share} (signed in; publish it with publish(share)) or {error}.
  async function finishSignIn() {
    const params = new URLSearchParams(location.search);
    if (!available() || !params.has("state")) return null;
    const url = new URL(location.href);
    for (const p of OAUTH_PARAMS) url.searchParams.delete(p);
    history.replaceState(null, "", url.href);

    let pending = null;
    try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY)); } catch { /* treated as missing */ }
    sessionStorage.removeItem(PENDING_KEY); // single use
    if (!pending || pending.state !== params.get("state") || Date.now() - pending.at > PENDING_MAX_AGE) {
      return { error: "The GitHub sign-in didn't match a share started in this tab, or took too long. Nothing was published; try sharing again." };
    }
    if (params.has("error")) {
      return { error: params.get("error") === "access_denied" ? "GitHub sign-in was cancelled. Nothing was published." : "GitHub sign-in failed. Nothing was published." };
    }
    if (!params.get("code")) return { error: "GitHub didn't return a sign-in code. Nothing was published." };

    let res;
    try {
      res = await fetch(config.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: params.get("code"), code_verifier: pending.verifier }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      return { error: "Couldn't reach the sign-in service. Nothing was published." };
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 429) return { error: "Too many sign-in attempts. Wait a minute and try again." };
    if (!res.ok || typeof data.access_token !== "string") {
      return { error: data.error === "bad_verification_code" ? "The GitHub sign-in expired. Nothing was published; try again." : "GitHub sign-in failed. Nothing was published." };
    }
    token = data.access_token;
    return { share: pending.share };
  }

  // Creates a secret gist with the export and returns {gistUrl, rawUrl}. Throws ShareError.
  async function publish({ code, filename, description }) {
    let res;
    try {
      res = await fetch("https://api.github.com/gists", {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ description, public: false, files: { [filename]: { content: code } } }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new ShareError("Couldn't reach GitHub. Nothing was published.");
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      token = null;
      throw new ShareError("GitHub no longer accepts this sign-in. Nothing was published; sign in again.");
    }
    if (res.status === 403 || res.status === 404) {
      throw new ShareError("GitHub didn't allow this editor to create gists. Nothing was published.");
    }
    if (!res.ok) throw new ShareError(`GitHub refused to create the gist (HTTP ${res.status}${data.message ? `: ${data.message}` : ""}).`);
    const rawUrl = data.files && data.files[filename] && data.files[filename].raw_url;
    // .../raw/<revision sha>/<file> is fixed to this revision; .../raw/<file> would follow edits.
    if (!/^https:\/\/gist\.githubusercontent\.com\/[^/]+\/[0-9a-f]+\/raw\/[0-9a-f]{40}\/[^/]+$/.test(rawUrl || "")) {
      throw new ShareError("GitHub created the gist but didn't return a usable file address.");
    }
    return { gistUrl: data.html_url, rawUrl };
  }

  return {
    available,
    signedIn: () => !!token,
    signOut: () => { token = null; },
    signInAndShare,
    finishSignIn,
    publish,
    ShareError,
    linkFor: (rawUrl) => `${pageBase()}?src=${encodeURIComponent(rawUrl)}`,
  };
})();
