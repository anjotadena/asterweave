// An in-process fake of the GitHub REST read endpoints the pipeline monitor uses. NO network: it is a `fetch` replacement.
// It models: pull requests, workflow runs (filtered by head_sha / event, Link pagination), jobs, check runs, branch protection,
// pull request files, per-call rate-limit headers, one-shot injected faults, and a call log.
//
// Everything about the response shapes is written from memory of the REST API and is NOT verified against live GitHub.

export function createFakeGithub({ owner = "o", repo = "r", pageSize = 100, now = Date.now } = {}) {
  const world = {
    pulls: new Map(),
    runs: [],
    checks: [],
    jobs: new Map(),
    files: [],
    protection: { status: 404, contexts: [] },
    rate: { limit: 5000, remaining: 5000, resetAtSec: Math.floor(now() / 1000) + 3600 },
    faults: [],
  };
  const calls = [];
  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...rateHeaders(), ...headers } });
  function rateHeaders() {
    return { "x-ratelimit-limit": String(world.rate.limit), "x-ratelimit-remaining": String(world.rate.remaining), "x-ratelimit-reset": String(world.rate.resetAtSec) };
  }
  const page = (items, field, url, extra = {}) => {
    const size = Number(url.searchParams.get("per_page")) || 30;
    const per = Math.min(size, pageSize);
    const n = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const slice = items.slice((n - 1) * per, n * per);
    const headers = {};
    if (n * per < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(n + 1));
      headers.link = `<${next.href}>; rel="next"`;
    }
    return json({ total_count: items.length, [field]: slice, ...extra }, 200, headers);
  };

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    calls.push({ url: url.href, path: url.pathname, search: url.search, method: init.method ?? "GET", headers: { ...(init.headers ?? {}) } });
    if (init.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    for (let i = 0; i < world.faults.length; i += 1) {
      const fault = world.faults[i];
      if (fault.match.test(url.pathname + url.search)) {
        world.faults.splice(i, 1);
        if (fault.throws) throw fault.throws;
        return fault.response();
      }
    }
    if (world.rate.remaining <= 0) return json({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" });
    world.rate.remaining -= 1;
    const prefix = `/repos/${owner}/${repo}/`;
    if (!url.pathname.startsWith(prefix)) return json({ message: "Not Found" }, 404);
    const rest = url.pathname.slice(prefix.length);
    let m;
    if ((m = /^pulls\/(\d+)$/.exec(rest))) {
      const pull = world.pulls.get(Number(m[1]));
      return pull ? json(pull) : json({ message: "Not Found" }, 404);
    }
    if (/^pulls\/\d+\/files$/.test(rest)) return json(world.files.map((filename) => ({ filename, status: "modified" })));
    if (rest === "actions/runs") {
      const sha = url.searchParams.get("head_sha");
      const event = url.searchParams.get("event");
      return page(world.runs.filter((run) => (sha === null || run.head_sha === sha) && (event === null || run.event === event)), "workflow_runs", url);
    }
    if ((m = /^actions\/runs\/(\d+)\/jobs$/.exec(rest))) return page(world.jobs.get(Number(m[1])) ?? [], "jobs", url);
    if ((m = /^commits\/([0-9a-f]+)\/check-runs$/.exec(rest))) {
      const all = world.checks.filter((check) => check.head_sha === m[1]);
      // filter=latest (the default) keeps only the newest check run per (app, name); filter=all returns every one.
      const newest = new Map();
      for (const check of all) {
        const key = `${check.app?.id ?? ""}|${check.name}`;
        const kept = newest.get(key);
        if (!kept || Date.parse(check.started_at) >= Date.parse(kept.started_at)) newest.set(key, check);
      }
      return page(url.searchParams.get("filter") === "all" ? all : [...newest.values()], "check_runs", url);
    }
    if (/^branches\/[^?]+\/protection\/required_status_checks$/.test(rest)) {
      return world.protection.status === 200 ? json({ strict: true, contexts: world.protection.contexts, checks: world.protection.contexts.map((context) => ({ context, app_id: (world.protection.apps ?? {})[context] ?? null })) }) : json({ message: world.protection.status === 403 ? "Forbidden" : "Not Found" }, world.protection.status);
    }
    return json({ message: "Not Found" }, 404);
  }

  const iso = (ms) => new Date(ms).toISOString();
  let nextId = 1000;
  return {
    fetch,
    world,
    calls,
    /** Open or merged pull request. */
    setPull(number, { state = "open", merged = false, headSha, mergeCommitSha = null, base = "main", head = "feature", mergedAt = null } = {}) {
      world.pulls.set(number, { number, title: "Fixture PR", state, merged, merged_at: mergedAt, merge_commit_sha: mergeCommitSha, head: { ref: head, sha: headSha }, base: { ref: base }, body: "", user: { login: "octo" } });
    },
    /** Add or replace a workflow run (same id + run_attempt replaces; a new attempt keeps the id). */
    setRun({ id = ++nextId, name = "CI", path = ".github/workflows/ci.yml", workflowId = 7, attempt = 1, status = "completed", conclusion = "success", event = "push", headSha, branch = "main", startedAt = now(), updatedAt = now() } = {}) {
      const run = { id, name, workflow_id: workflowId, path, run_number: id, run_attempt: attempt, status, conclusion, event, head_sha: headSha, head_branch: branch, html_url: `https://github.com/${owner}/${repo}/actions/runs/${id}`, created_at: iso(startedAt), updated_at: iso(updatedAt), run_started_at: iso(startedAt) };
      const at = world.runs.findIndex((item) => item.id === id);
      if (at >= 0) world.runs[at] = run;
      else world.runs.push(run);
      return run;
    },
    setCheck({ id = ++nextId, name, headSha, appId = 15368, suiteId = null, status = "completed", conclusion = "success", startedAt = now(), completedAt = now(), title = null, summary = null } = {}) {
      const check = { id, name, head_sha: headSha, status, conclusion, started_at: iso(startedAt), completed_at: status === "completed" ? iso(completedAt) : null, html_url: `https://github.com/${owner}/${repo}/runs/${id}`, output: { title, summary }, app: appId === null ? null : { id: appId }, check_suite: suiteId === null ? null : { id: suiteId } };
      const at = world.checks.findIndex((item) => item.id === id);
      if (at >= 0) world.checks[at] = check;
      else world.checks.push(check);
      return check;
    },
    setJobs(runId, jobs) {
      world.jobs.set(runId, jobs.map((job, index) => ({ id: runId * 10 + index, status: "completed", conclusion: "success", steps: [], started_at: iso(now()), completed_at: iso(now()), html_url: `https://github.com/${owner}/${repo}/actions/runs/${runId}/job/${index}`, ...job })));
    },
    /** Make the next request whose path+query matches `match` fail once. */
    fault(match, response, throws) {
      world.faults.push({ match, response, throws });
    },
    setRate(patch) {
      Object.assign(world.rate, patch);
    },
  };
}
