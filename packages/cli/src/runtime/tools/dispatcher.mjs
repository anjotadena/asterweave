// A ToolDispatcher ({id, dispatch(action, ctx)}, see executor.mjs) for the `api` and `mcp` tool classes, backed by a
// capability registry. It is usable by the run loop, but the default `run start` development path still uses the simulated
// dispatcher: nothing here is wired into a real run yet (Phase D does that).
//
//   registryDispatcher({ registry, guardContext, artifactDir?, fs?, guard? })
//
// `guardContext(action, ctx)` (sync or async) returns the guard context for THIS call: mode, policy, lockHeld, apiAllow and, for
// mcp, the CURRENT state of each server (including a descriptor hash recomputed from the live definition and tool list). The
// loop has already judged the action once; the dispatcher judges it again just before running, because it is the last place
// where the tool list or an approval can have changed since.
//
// action.tool.input:
//   api  { tool: "<registry id>", method?: "GET", url, args?: {...} }   the registry tool's own request(args) must equal {method, url}
//   mcp  { server, tool, args?: {...} }                                 registry id: mcp.<server>.<tool>
//
// The result carries the UNTRUSTED envelope serialized into `output` (the loop keeps only ok / output / error); a refusal is
// {ok:false, error}. Neither the output nor the error is ever treated as an instruction.

import { stringifyJson } from "../../json.mjs";
import { redactText, sanitizeForTerminal } from "../../redact.mjs";
import { evaluateDispatch, evaluateMutation, isBlocking } from "../guard.mjs";

const safe = (text) => redactText(sanitizeForTerminal(String(text ?? ""))).text.slice(0, 300);

/** Registry id of an MCP tool. */
export const mcpToolId = (server, tool) => `mcp.${server}.${tool}`;

export function registryDispatcher({ registry, guardContext, artifactDir, fs, guard = { evaluateDispatch, evaluateMutation } } = {}) {
  if (!registry || typeof registry.invoke !== "function") throw new TypeError("registryDispatcher needs a registry");
  if (typeof guardContext !== "function") throw new TypeError("registryDispatcher needs a guardContext(action, ctx) function");
  const calls = [];
  const refuse = (error) => ({ ok: false, error: safe(error) });

  async function judge(action, ctx) {
    const gctx = await guardContext(action, ctx);
    const decision = guard.evaluateDispatch(action, gctx);
    if (decision.decision === "allow" && decision.detail?.mutating === true) return guard.evaluateMutation(action, gctx);
    return decision;
  }

  async function dispatch(action, ctx = {}) {
    const name = action?.tool?.name;
    const input = action?.tool?.input ?? {};
    calls.push({ tool: name ?? null, node: ctx.node ?? null });
    if (name !== "api" && name !== "mcp") return refuse(`the registry dispatcher does not carry out '${safe(name)}' tools`);
    let id;
    let args;
    if (name === "api") {
      id = typeof input.tool === "string" ? input.tool : null;
      args = input.args ?? {};
      const described = id === null ? null : registry.get(id);
      if (described === null || described.kind !== "api") return refuse("no such api tool is registered");
      const request = registry.requestOf(id, args);
      if (!request || request.method !== (input.method ?? "GET") || request.url !== input.url) return refuse("the request does not match what the api tool would send");
    } else {
      id = typeof input.server === "string" && typeof input.tool === "string" ? mcpToolId(input.server, input.tool) : null;
      args = input.args ?? {};
      const described = id === null ? null : registry.get(id);
      if (described === null || described.kind !== "mcp" || described.origin.server !== input.server || described.origin.tool !== input.tool) return refuse("no such mcp tool is registered");
    }
    if (typeof ctx.node === "string" && !registry.get(id).stages.includes(ctx.node)) return refuse("this tool is not offered at the current stage");
    let decision;
    try {
      decision = await judge(action, ctx);
    } catch (error) {
      return refuse(`the guard could not evaluate this call (${error?.name ?? "error"})`);
    }
    if (decision.decision !== "allow" || isBlocking(decision)) return refuse(`the guard did not allow this call (${decision.decision}: ${decision.reason})`);
    const result = await registry.invoke(id, args, { node: ctx.node, signal: ctx.signal, sleep: ctx.sleep, artifactDir, fs });
    const envelope = result.ok
      ? { trust: result.trust, source: result.source, content: result.content }
      : { trust: result.trust, source: result.source, error: result.error };
    return result.ok ? { ok: true, output: stringifyJson(envelope) } : { ok: false, error: stringifyJson(envelope) };
  }

  return { id: "registry", calls, dispatch };
}
