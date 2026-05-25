// appdeck-feedback-worker
//
// Cloudflare Worker. Receives an AppDeck "Report a problem" payload
// at POST /report, validates + sanitizes + rate-limits, then creates
// a corresponding issue in rozos1979/appdeck-feedback using a
// fine-grained GitHub PAT held in the Worker's secret store
// (env.GITHUB_TOKEN).
//
// Privacy: this Worker stores nothing except per-IP rate-limit
// counters in KV. Payload bodies pass through to GitHub; the Worker
// itself doesn't log them. Cloudflare's dashboard sees req volume +
// status codes only.
//
// PAT rotation: regenerate on github.com/settings/personal-access-tokens,
// then `wrangler secret put GITHUB_TOKEN`. No code change needed.

export interface Env {
  /** Fine-grained PAT, scope: issues:write on TARGET_REPO. Set via
   *  wrangler secret put GITHUB_TOKEN. */
  GITHUB_TOKEN: string;
  /** Per-IP rate-limit counter store. Set up via
   *  wrangler kv:namespace create RATE_LIMIT_KV; paste the id into
   *  wrangler.toml. */
  RATE_LIMIT_KV: KVNamespace;
  /** Repo to file issues into. Configured via [vars] in wrangler.toml. */
  TARGET_REPO: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_CATEGORIES = ["bug", "question", "feature"] as const;
type Category = (typeof ALLOWED_CATEGORIES)[number];

const ALLOWED_OS = ["windows", "macos", "linux", "other"] as const;
type Os = (typeof ALLOWED_OS)[number];

const TITLE_MIN = 1;
const TITLE_MAX = 200;
const DESC_MIN = 10;
const DESC_MAX = 4000;
const VERSION_MAX = 32;
const EMAIL_MAX = 254;
const STACK_MAX = 8000;
const BREADCRUMBS_MAX = 25;

const RATE_LIMIT_PER_MIN = 5;
const RATE_LIMIT_PER_DAY = 50;

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

interface ReportPayload {
  category: Category;
  title: string;
  description: string;
  appVersion: string;
  os: Os;
  userAgent?: string;
  deviceId?: string;
  email?: string;
  crashStack?: string;
  sentryEventId?: string;
  breadcrumbs?: Array<{ type: string; status?: string }>;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight. Tauri's WebView Origin header is unpredictable
    // (file://, tauri://localhost, https://tauri.localhost depending
    // on OS + version). We accept all origins because the Worker's
    // actual security is: rate-limit + payload validation + the fact
    // that it only creates issues, can't read or delete.
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    if (req.method !== "POST") {
      return jsonError("Method not allowed", 405);
    }

    // Health-check endpoint for monitoring / smoke tests.
    if (url.pathname === "/health") {
      return jsonOk({ ok: true, version: "0.1.0" });
    }

    if (url.pathname !== "/report") {
      return jsonError(`Unknown endpoint: ${url.pathname}`, 404);
    }

    // Per-IP rate limit. CF-Connecting-IP is set by Cloudflare's
    // edge for every inbound request; "anon" only fires when we're
    // tested via something exotic.
    const ip = req.headers.get("CF-Connecting-IP") ?? "anon";
    const limitCheck = await checkAndBumpRateLimit(env.RATE_LIMIT_KV, ip);
    if (!limitCheck.ok) {
      return jsonError(limitCheck.reason, 429);
    }

    // Body parsing + validation.
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonError("Request body is not valid JSON", 400);
    }
    const validation = validate(body);
    if (!validation.ok) return jsonError(validation.error, 400);
    const payload = validation.payload;

    // Build the issue body + ship to GitHub.
    const issueBody = formatIssueBody(payload);
    const issueLabels = buildLabels(payload);

    try {
      const ghResponse = await fetch(
        `https://api.github.com/repos/${env.TARGET_REPO}/issues`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "appdeck-feedback-worker/0.1",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: payload.title,
            body: issueBody,
            labels: issueLabels,
          }),
        },
      );

      if (!ghResponse.ok) {
        const ghText = await ghResponse.text();
        // eslint-disable-next-line no-console
        console.error(
          `GitHub returned ${ghResponse.status}: ${ghText.slice(0, 500)}`,
        );
        return jsonError(
          `Upstream GitHub error (${ghResponse.status}). Try again in a minute.`,
          502,
        );
      }

      const created = (await ghResponse.json()) as {
        html_url: string;
        number: number;
      };
      return jsonOk({
        ok: true,
        issue_url: created.html_url,
        issue_number: created.number,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Fetch to GitHub threw:", (e as Error).message);
      return jsonError(
        "Couldn't reach GitHub right now. Try again in a minute.",
        502,
      );
    }
  },
};

// ---------------------------------------------------------------------------
// Validation + sanitization
// ---------------------------------------------------------------------------

type ValidationResult =
  | { ok: true; payload: ReportPayload }
  | { ok: false; error: string };

function validate(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const r = raw as Record<string, unknown>;

  if (!isAllowedString(r.category, ALLOWED_CATEGORIES as readonly string[])) {
    return { ok: false, error: "category must be one of: bug, question, feature" };
  }
  if (!isString(r.title) || r.title.length < TITLE_MIN || r.title.length > TITLE_MAX) {
    return {
      ok: false,
      error: `title must be a string of ${TITLE_MIN}-${TITLE_MAX} characters`,
    };
  }
  if (
    !isString(r.description) ||
    r.description.length < DESC_MIN ||
    r.description.length > DESC_MAX
  ) {
    return {
      ok: false,
      error: `description must be a string of ${DESC_MIN}-${DESC_MAX} characters`,
    };
  }
  if (!isString(r.appVersion) || r.appVersion.length > VERSION_MAX) {
    return { ok: false, error: "appVersion required (string)" };
  }
  if (!isAllowedString(r.os, ALLOWED_OS as readonly string[])) {
    return { ok: false, error: "os must be one of: windows, macos, linux, other" };
  }
  // Optional fields — typecheck only if present.
  if (r.userAgent !== undefined && !isString(r.userAgent)) {
    return { ok: false, error: "userAgent must be a string if provided" };
  }
  if (r.deviceId !== undefined && !isString(r.deviceId)) {
    return { ok: false, error: "deviceId must be a string if provided" };
  }
  if (r.email !== undefined) {
    if (!isString(r.email) || r.email.length > EMAIL_MAX) {
      return { ok: false, error: "email must be a string if provided" };
    }
  }
  if (r.crashStack !== undefined && !isString(r.crashStack)) {
    return { ok: false, error: "crashStack must be a string if provided" };
  }
  if (r.sentryEventId !== undefined && !isString(r.sentryEventId)) {
    return { ok: false, error: "sentryEventId must be a string if provided" };
  }
  if (r.breadcrumbs !== undefined) {
    if (!Array.isArray(r.breadcrumbs) || r.breadcrumbs.length > BREADCRUMBS_MAX) {
      return {
        ok: false,
        error: `breadcrumbs must be an array of <= ${BREADCRUMBS_MAX} items`,
      };
    }
  }

  // Sanitize: trim, strip control chars, length-cap (defensive — the
  // client already capped, but the Worker is the security boundary).
  const payload: ReportPayload = {
    category: r.category as Category,
    title: sanitizeOneLine(r.title as string).slice(0, TITLE_MAX),
    description: sanitizeMultiLine(r.description as string).slice(0, DESC_MAX),
    appVersion: sanitizeOneLine(r.appVersion as string).slice(0, VERSION_MAX),
    os: r.os as Os,
    userAgent: isString(r.userAgent)
      ? sanitizeOneLine(r.userAgent).slice(0, 256)
      : undefined,
    deviceId: isString(r.deviceId)
      ? sanitizeOneLine(r.deviceId).slice(0, 64)
      : undefined,
    email: isString(r.email)
      ? sanitizeOneLine(r.email).slice(0, EMAIL_MAX)
      : undefined,
    crashStack: isString(r.crashStack)
      ? sanitizeMultiLine(r.crashStack).slice(0, STACK_MAX)
      : undefined,
    sentryEventId: isString(r.sentryEventId)
      ? sanitizeOneLine(r.sentryEventId).slice(0, 64)
      : undefined,
    breadcrumbs: Array.isArray(r.breadcrumbs)
      ? (r.breadcrumbs as Array<unknown>)
          .filter(
            (b) =>
              b !== null &&
              typeof b === "object" &&
              isString((b as Record<string, unknown>).type),
          )
          .map((b) => ({
            type: sanitizeOneLine(
              (b as Record<string, unknown>).type as string,
            ).slice(0, 64),
            status: isString((b as Record<string, unknown>).status)
              ? sanitizeOneLine(
                  (b as Record<string, unknown>).status as string,
                ).slice(0, 16)
              : undefined,
          }))
      : undefined,
  };
  return { ok: true, payload };
}

function isString(x: unknown): x is string {
  return typeof x === "string";
}

function isAllowedString(x: unknown, allowed: readonly string[]): x is string {
  return typeof x === "string" && allowed.includes(x);
}

function sanitizeOneLine(s: string): string {
  // Strip control chars + collapse whitespace. Keeps Unicode letters,
  // numbers, punctuation. Prevents log injection / GitHub markdown
  // shenanigans that hinge on \r tricks.
  return s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeMultiLine(s: string): string {
  // Preserve newlines but normalize CRLF → LF + drop other control
  // chars + drop trailing whitespace per line.
  return s
    .replace(/\r\n/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Issue formatting
// ---------------------------------------------------------------------------

function formatIssueBody(p: ReportPayload): string {
  const parts: string[] = [];

  parts.push("## Description");
  parts.push("");
  parts.push(p.description);
  parts.push("");

  parts.push("---");
  parts.push("");
  parts.push("## Reporter context");
  parts.push("");
  parts.push(`- **AppDeck version**: \`${p.appVersion}\``);
  parts.push(`- **OS**: \`${p.os}\``);
  if (p.userAgent) parts.push(`- **User agent**: \`${truncate(p.userAgent, 120)}\``);
  if (p.deviceId) parts.push(`- **Anonymous device ID**: \`${p.deviceId}\``);
  if (p.email) parts.push(`- **Contact** (provided for follow-up): ${p.email}`);
  if (p.sentryEventId) {
    parts.push(`- **Sentry crash report**: \`${p.sentryEventId}\``);
  }
  parts.push("");

  if (p.breadcrumbs && p.breadcrumbs.length > 0) {
    parts.push("## Recent actions (last ~10)");
    parts.push("");
    for (const b of p.breadcrumbs.slice(-10)) {
      const tag = b.status === "error" ? "⚠️" : "•";
      parts.push(`- ${tag} \`${b.type}\``);
    }
    parts.push("");
  }

  if (p.crashStack) {
    parts.push("## Crash stack");
    parts.push("");
    parts.push("```");
    parts.push(truncate(p.crashStack, STACK_MAX));
    parts.push("```");
    parts.push("");
  }

  parts.push("---");
  parts.push("");
  parts.push(
    "_This issue was auto-created by the AppDeck in-app reporter " +
      "(Settings → Help → Report a problem). The reporter scrubs paths, " +
      "URLs, secrets, and other PII before submission._",
  );
  return parts.join("\n");
}

function buildLabels(p: ReportPayload): string[] {
  return [
    p.category,
    `os-${p.os === "other" ? "other" : p.os}`,
    `v${p.appVersion}`,
    "needs-triage",
    "from-app",
    ...(p.sentryEventId ? ["auto-crash"] : []),
  ];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\n…[truncated]";
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

interface RateLimitState {
  minWindowStart: number;
  minCount: number;
  dayWindowStart: number;
  dayCount: number;
}

async function checkAndBumpRateLimit(
  kv: KVNamespace,
  ip: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const key = `ratelimit:${ip}`;
  const now = Date.now();
  const minWindowMs = 60_000;
  const dayWindowMs = 24 * 60 * 60_000;

  const stored = await kv.get(key);
  let state: RateLimitState;
  if (stored) {
    try {
      state = JSON.parse(stored) as RateLimitState;
    } catch {
      state = freshState(now);
    }
  } else {
    state = freshState(now);
  }

  // Slide windows: reset min counter every 60s, day counter every 24h.
  if (now - state.minWindowStart > minWindowMs) {
    state.minWindowStart = now;
    state.minCount = 0;
  }
  if (now - state.dayWindowStart > dayWindowMs) {
    state.dayWindowStart = now;
    state.dayCount = 0;
  }

  if (state.minCount >= RATE_LIMIT_PER_MIN) {
    return {
      ok: false,
      reason: `Too many reports from your IP. Try again in ${Math.ceil((state.minWindowStart + minWindowMs - now) / 1000)}s.`,
    };
  }
  if (state.dayCount >= RATE_LIMIT_PER_DAY) {
    return {
      ok: false,
      reason: "Daily report limit reached for your IP. Try again tomorrow.",
    };
  }

  state.minCount += 1;
  state.dayCount += 1;
  // KV ttl 25h so day windows that span midnight don't get evicted
  // mid-window.
  await kv.put(key, JSON.stringify(state), { expirationTtl: 26 * 60 * 60 });
  return { ok: true };
}

function freshState(now: number): RateLimitState {
  return { minWindowStart: now, minCount: 0, dayWindowStart: now, dayCount: 0 };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonOk(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
