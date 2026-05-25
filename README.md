# appdeck-feedback-worker

Cloudflare Worker that receives in-app feedback reports from AppDeck (v0.77.0+) and creates corresponding GitHub issues in [`rozos1979/appdeck-feedback`](https://github.com/rozos1979/appdeck-feedback).

```
┌──────────────────────────┐    POST /report     ┌─────────────────────────┐
│ AppDeck                  │ ──────────────────▶ │ This Worker             │
│ (Settings → Help →       │  {title, desc,      │ (Cloudflare)            │
│  Report a problem)       │   version, os, …}   │  - rate-limit per IP    │
└──────────────────────────┘                     │  - validate + sanitize  │
                                                 │  - POST GitHub Issues   │
                                                 │    API w/ fine-grained  │
                                                 │    PAT (in secret store)│
                                                 └────────────┬────────────┘
                                                              │
                                                              ▼
                                              ┌──────────────────────────┐
                                              │ rozos1979/               │
                                              │   appdeck-feedback       │
                                              │ Issue #42 created        │
                                              └──────────────────────────┘
```

## Why this exists

GitHub's API requires authentication to write (create issues). We can't ship a token in the AppDeck binary (extractable + spammable). So the Worker holds the token and AppDeck talks to the Worker instead.

Users never need a GitHub account.

## First-time setup (manual steps you do once)

You need three things:

1. **Cloudflare account** — free tier covers ~100k Worker requests/day; sign up at https://dash.cloudflare.com/sign-up
2. **GitHub fine-grained PAT** — scope: `issues:write` on `rozos1979/appdeck-feedback` ONLY
3. **wrangler CLI** — `npm install -g wrangler` then `wrangler login` (opens browser for Cloudflare OAuth)

### Step-by-step

```bash
# 1. Install wrangler (Cloudflare's deploy CLI)
npm install -g wrangler

# 2. Authenticate with Cloudflare (opens browser)
wrangler login

# 3. From this repo's root:
cd appdeck-feedback-worker

# 4. Create the KV namespace used for per-IP rate limiting
wrangler kv:namespace create RATE_LIMIT_KV
# ⬆ Copy the `id = "..."` from the output and paste it into wrangler.toml
#   under [[kv_namespaces]] -> id. (Production binding only — preview is
#   skipped because the Worker is small enough not to need a staging env.)

# 5. Create the GitHub PAT
#    https://github.com/settings/personal-access-tokens/new
#    Resource owner:  rozos1979
#    Repository access: Only select repositories → appdeck-feedback
#    Permissions:     Repository → Issues: Read and write
#    Expiration:      365 days
#    Click "Generate token" — copy it (starts with `github_pat_`)

# 6. Store the PAT in the Worker's secret store (paste when prompted)
wrangler secret put GITHUB_TOKEN

# 7. Deploy
wrangler deploy
# ⬆ Worker is now live at https://appdeck-feedback.<your-cf-handle>.workers.dev
#   Copy this URL — AppDeck v0.77.0 will hit it.
```

After step 7, the Worker URL goes into AppDeck's `src/services/manualFeedback.ts` (committed via v0.77.0 ship) and the in-app reporter starts working.

## Endpoint

### `POST /report`

Body:

```json
{
  "category": "bug" | "question" | "feature",
  "title": "string (1-200 chars)",
  "description": "string (1-4000 chars)",
  "appVersion": "0.77.0",
  "os": "windows" | "macos" | "linux" | "other",
  "userAgent": "string (optional)",
  "deviceId": "string (optional, anonymous UUID)",
  "email": "string (optional, for follow-up)",
  "crashStack": "string (optional, when launched from ErrorBoundary)",
  "sentryEventId": "string (optional, to cross-link with auto-crash)",
  "breadcrumbs": [{"type": "action_type", "status": "ok|error"}]
}
```

Response (success, `200`):

```json
{
  "ok": true,
  "issue_url": "https://github.com/rozos1979/appdeck-feedback/issues/42",
  "issue_number": 42
}
```

Response (failure):

```json
{ "ok": false, "error": "human-readable error message" }
```

Errors: `400` invalid payload, `429` rate-limited, `502` GitHub upstream error.

## Rate limits

- **5 requests / minute per IP** (sliding window via KV)
- **50 requests / day per IP** (sliding window via KV)

A user who exceeds either gets a `429` with an explanatory message. The AppDeck client shows it as a toast with a "Copy diagnostics" fallback so they can email the report instead.

## Privacy

The Worker is a pass-through; it doesn't store payloads anywhere except the resulting GitHub issue. KV holds only request count + last-seen timestamp per IP (no payload data). Logs in Cloudflare's dashboard show request volume + error rate, never bodies.

The Worker assumes the AppDeck client has already scrubbed PII (it has — see `src/services/crashReporting.ts` `scrubString()` in the main repo). The Worker re-runs a less aggressive sanitizer mostly to enforce length caps + strip HTML.

## Local development

```bash
wrangler dev
# Serves the Worker locally at http://localhost:8787
# Use a test PAT in .dev.vars (NOT committed) for local testing
```

`.dev.vars`:
```
GITHUB_TOKEN=github_pat_test_...
```

## Updates

- Change Worker code, `git commit`, `wrangler deploy`. That's it.
- Rotate the PAT: regenerate on GitHub, then `wrangler secret put GITHUB_TOKEN` to upload the new one. No code change.
- KV namespace ID is in `wrangler.toml` — rarely changes.
