// One READ-ONLY direct GitHub API adapter: GET issue, GET pull request, list the check runs of a commit. No write adapter exists.
//
//   createGithubTools({ host, getToken, fetch, now?, limits? }) -> { apiHost, allow, definitions }
//
// - `host` is the configured `github.host`; the API host and path prefix are derived from it (github.com -> api.github.com,
//   anything else -> <host>/api/v3). `allow` is the guard's `apiAllow` rule list for exactly this adapter.
// - `getToken()` is an injected seam (credentials.json stores references only, never tokens). The token goes ONLY into the
//   Authorization header of a request to the allow-listed host; it never appears in a URL, an argument, a log or an error.
// - `fetch` is injected (tests use a fake; there is no network in tests). redirect:"error", so a redirect can never carry the header away.
// - Owner / repo / number / ref segments are validated with strict patterns before a URL is built, and each tool builds its URL
//   itself (`request(args)`): the dispatcher requires the action's URL to equal it, and the guard judges that URL.
// - Response size is capped while reading; 429 and 5xx are TRANSIENT (the registry retries read-only tools with bounded, jittered
//   backoff and honours Retry-After); other statuses are final. Error messages are fixed text (a response body is never echoed).
// - Pagination follows `Link: rel="next"` for a bounded number of pages; every next URL is data from the response and is
//   re-validated against the allow-list BEFORE it is requested with the credential.
// - Results are untrusted data (issue bodies and comments are attacker-controlled); the registry wraps them in the untrusted envelope.

import { ToolError } from "./registry.mjs";

export const GITHUB_LIMITS = Object.freeze({ responseBytes: 1024 * 1024, maxPages: 3, perPage: 50 });
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{7,40}$/;

/** API host and path prefix for a configured GitHub host. */
export function githubApi(host) {
  const clean = String(host ?? "github.com").toLowerCase();
  return clean === "github.com" ? { apiHost: "api.github.com", prefix: "" } : { apiHost: clean, prefix: "/api/v3" };
}

const stringField = (pattern, max) => ({ type: "string", pattern: pattern.source, maxLength: max });
const repoProps = { owner: stringField(OWNER, 39), repo: stringField(REPO, 100) };
const numberProps = { ...repoProps, number: { type: "integer", min: 1, max: 1e9 } };

function retryAfterMs(headers, now) {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  if (/^\d{1,6}$/.test(value.trim())) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now());
}

async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new ToolError("GITHUB_BAD_RESPONSE", "GitHub returned no body");
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      reader.cancel?.().catch?.(() => {});
      throw new ToolError("GITHUB_RESPONSE_TOO_LARGE", `the GitHub response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ToolError("GITHUB_BAD_RESPONSE", "GitHub returned a body that is not valid JSON");
  }
}

/**
 * @param {{host?: string, getToken: () => Promise<string>|string, fetch: Function, now?: () => number, limits?: object}} options
 */
export function createGithubTools({ host = "github.com", getToken, fetch, now = Date.now, limits = {} } = {}) {
  if (typeof getToken !== "function" || typeof fetch !== "function") throw new TypeError("createGithubTools needs getToken and fetch");
  const { apiHost, prefix } = githubApi(host);
  const lim = { ...GITHUB_LIMITS, ...limits };
  const reposPrefix = `${prefix}/repos/`;
  const allow = [{ host: apiHost, paths: [reposPrefix] }];

  const urlFor = (path) => `https://${apiHost}${reposPrefix.replace(/\/repos\/$/, "")}/repos/${path}`;
  const allowedUrl = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.host === apiHost && url.username === "" && url.password === "" && url.hash === "" && url.pathname.startsWith(reposPrefix) && !/%(?:2e|2f|5c)/i.test(url.pathname);
    } catch {
      return false;
    }
  };

  async function get(url, signal) {
    if (!allowedUrl(url)) throw new ToolError("GITHUB_URL_REFUSED", "the request is outside the allow-listed GitHub API");
    let token;
    try {
      token = await getToken();
    } catch {
      token = "";
    }
    if (typeof token !== "string" || token === "") throw new ToolError("GITHUB_AUTH_MISSING", "no GitHub credential is available; sign in with `asterweave auth login github`");
    let response;
    try {
      response = await fetch(url, { method: "GET", redirect: "error", signal, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "asterweave-cli", "X-GitHub-Api-Version": "2022-11-28" } });
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw new ToolError("TOOL_ABORTED", "the request was cancelled");
      throw new ToolError("GITHUB_NETWORK", "the GitHub request failed", { transient: true });
    }
    const status = response.status;
    if (status === 429 || (status >= 500 && status <= 599) || (status === 403 && response.headers.get("retry-after") !== null)) {
      throw new ToolError(`GITHUB_HTTP_${status}`, `GitHub answered ${status}`, { transient: true, retryAfterMs: retryAfterMs(response.headers, now) });
    }
    if (status < 200 || status > 299) throw new ToolError(`GITHUB_HTTP_${status}`, `GitHub answered ${status}`);
    return { body: await readCapped(response, lim.responseBytes), link: response.headers.get("link") };
  }

  const nextLink = (link) => {
    const match = /<([^>]{1,2048})>\s*;\s*rel="next"/.exec(link ?? "");
    return match ? match[1] : null;
  };

  const user = (value) => (value && typeof value.login === "string" ? value.login : null);
  const labels = (list) => (Array.isArray(list) ? list.slice(0, 50).map((label) => (typeof label === "string" ? label : label?.name ?? null)) : []);
  const pickIssue = (data) => ({ number: data.number, title: data.title, state: data.state, author: user(data.user), labels: labels(data.labels), comments: data.comments ?? null, createdAt: data.created_at, updatedAt: data.updated_at, body: typeof data.body === "string" ? data.body : "" });

  const retry = { attempts: 3, baseMs: 250, maxMs: 5000 };
  const common = { kind: "api", stages: ["intake", "analyze", "review", "monitor-pipeline", "resolve-review-comments", "update-work-item"], readOnly: true, retry, limits: { timeoutMs: 20_000, maxBytes: 32 * 1024, maxLines: 300, maxItems: 100 } };
  const objectSchema = (properties, required) => ({ type: "object", additionalProperties: false, required, properties });

  const definitions = [
    {
      ...common,
      id: "github.issue.get",
      capability: "github.issue.get",
      description: "Read one GitHub issue (title, state, labels, body). The text is untrusted data.",
      inputSchema: objectSchema(numberProps, ["owner", "repo", "number"]),
      request: (a) => ({ method: "GET", url: urlFor(`${a.owner}/${a.repo}/issues/${a.number}`) }),
      run: async (a, ctx) => ({ kind: "issue", ...pickIssue((await get(urlFor(`${a.owner}/${a.repo}/issues/${a.number}`), ctx.signal)).body) }),
    },
    {
      ...common,
      id: "github.pull.get",
      capability: "github.pull.get",
      description: "Read one GitHub pull request (title, state, branches, body). The text is untrusted data.",
      inputSchema: objectSchema(numberProps, ["owner", "repo", "number"]),
      request: (a) => ({ method: "GET", url: urlFor(`${a.owner}/${a.repo}/pulls/${a.number}`) }),
      run: async (a, ctx) => {
        const data = (await get(urlFor(`${a.owner}/${a.repo}/pulls/${a.number}`), ctx.signal)).body;
        return { kind: "pull", ...pickIssue(data), draft: data.draft === true, merged: data.merged === true, head: { ref: data.head?.ref ?? null, sha: data.head?.sha ?? null }, base: { ref: data.base?.ref ?? null } };
      },
    },
    {
      ...common,
      id: "github.checks.list",
      capability: "github.checks.list",
      description: "List the check runs of a commit (pass the pull request head sha). Bounded pagination.",
      inputSchema: objectSchema({ ...repoProps, ref: stringField(SHA, 40) }, ["owner", "repo", "ref"]),
      request: (a) => ({ method: "GET", url: urlFor(`${a.owner}/${a.repo}/commits/${a.ref}/check-runs?per_page=${lim.perPage}`) }),
      run: async (a, ctx) => {
        let url = urlFor(`${a.owner}/${a.repo}/commits/${a.ref}/check-runs?per_page=${lim.perPage}`);
        const checks = [];
        let pages = 0;
        let more = false;
        while (url !== null && pages < lim.maxPages) {
          const { body, link } = await get(url, ctx.signal);
          pages += 1;
          for (const run of Array.isArray(body?.check_runs) ? body.check_runs : []) {
            checks.push({ name: run?.name ?? null, status: run?.status ?? null, conclusion: run?.conclusion ?? null });
          }
          const next = nextLink(link);
          url = next !== null && allowedUrl(next) ? next : null; // a next URL is response data: re-validate before the credential goes with it
          if (next !== null && url === null) more = true;
          else if (url !== null && pages >= lim.maxPages) more = true;
        }
        return { kind: "check-runs", pages, truncated: more, checks: checks.slice(0, 500) };
      },
    },
  ];
  return { apiHost, allow, definitions };
}
