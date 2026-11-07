// MCP stdio client (zero dependencies). Newline-delimited JSON-RPC 2.0 over a child's stdio:
// initialize (protocol version negotiation) -> notifications/initialized -> tools/list (cursor pages, bounded) -> tools/call.
//
// Safety rules enforced here:
//   - spawned with shell:false, an ABSOLUTE command, a minimal environment (PATH, plus SystemRoot/windir on Windows, plus ONLY the
//     env entries the caller resolved), cwd given by the caller (the repository root), stdin/stdout/stderr piped, stderr bounded;
//   - frames are split on 0x0A at the Buffer level, the size limit is applied BEFORE decoding, decoding is strict UTF-8;
//   - protocol violations (malformed JSON, non-object frames, a response with an unknown or already settled id, oversized or
//     non-UTF-8 frames) fail the connection and kill the child; a server REQUEST (sampling, roots, elicitation, anything with
//     both id and method) is answered with -32601 and never acted upon; notifications are ignored (list_changed is noted);
//   - every request has a timeout, the whole session an optional deadline/AbortSignal; on timeout, abort, crash or close the
//     whole process tree is killed (taskkill /T on Windows, a process group signal elsewhere) so no orphan survives;
//   - server-provided names and descriptions are validated, sanitized, redacted and capped before anyone can display them.

import { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import { stringifyJson } from "../../json.mjs";
import { redactText, sanitizeForTerminal } from "../../redact.mjs";
import { toPlainData } from "./bounds.mjs";
import { boundedCanonicalJson } from "./descriptor.mjs";

export const SUPPORTED_PROTOCOLS = Object.freeze(["2025-06-18", "2025-03-26", "2024-11-05"]);
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
export const CLIENT_LIMITS = Object.freeze({ messageBytes: 1024 * 1024, stderrBytes: 16 * 1024, requestTimeoutMs: 15_000, maxPages: 10, maxUnsolicited: 100, maxTools: 200, descriptionChars: 1000, cursorChars: 1024, schemaChars: 64 * 1024 });

/** An MCP failure with a stable code, safe message and a remediation. `unavailable` marks "cannot be used here", not a bug. */
export class McpError extends Error {
  constructor(code, message, { remediation, unavailable = false } = {}) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.remediation = remediation;
    this.unavailable = unavailable;
  }
}

const safe = (value, length = 300) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, length);

/** Kill a child and everything it started. Injectable; this is the default. */
export function killProcessTree(child, { platform = process.platform, env = process.env, spawn = nodeSpawn, kill = process.kill.bind(process) } = {}) {
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (platform === "win32") {
      const root = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
      const killer = spawn(path.win32.join(root, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      killer.on?.("error", () => { try { child.kill("SIGKILL"); } catch { /* gone */ } });
      killer.unref?.();
    } else {
      try {
        kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    try { child.kill("SIGKILL"); } catch { /* gone */ }
  }
}

function minimalEnv(declared, { platform, hostEnv }) {
  const env = {};
  const pick = (key) => {
    const actual = Object.keys(hostEnv).find((name) => (platform === "win32" ? name.toLowerCase() === key.toLowerCase() : name === key));
    if (actual !== undefined && typeof hostEnv[actual] === "string") env[key] = hostEnv[actual];
  };
  pick("PATH");
  if (platform === "win32") for (const key of ["SystemRoot", "windir"]) pick(key);
  return { ...env, ...declared };
}

function flatten(content) {
  if (!Array.isArray(content)) return "";
  return content
    .slice(0, 100)
    .map((part) => {
      if (part && part.type === "text" && typeof part.text === "string") return part.text;
      if (part && typeof part.type === "string") return `[${safe(part.type, 20)} content omitted]`;
      return "[unknown content omitted]";
    })
    .join("\n");
}

/**
 * Start a server and return a connected-but-uninitialized client.
 *
 * @param {{command: string, args?: string[], cwd: string, env?: Record<string,string>}} server  `command` must be absolute; env = already resolved.
 * @param {{spawn?: Function, platform?: string, hostEnv?: object, signal?: AbortSignal, deadlineMs?: number, limits?: object,
 *   killTree?: Function, clientInfo?: {name: string, version: string}}} [options]
 */
export function startMcpClient(server, options = {}) {
  const platform = options.platform ?? process.platform;
  const limits = { ...CLIENT_LIMITS, ...options.limits };
  const spawn = options.spawn ?? nodeSpawn;
  const killTree = options.killTree ?? ((child) => killProcessTree(child, { platform, env: options.hostEnv ?? process.env }));
  const isAbsolute = (platform === "win32" ? path.win32 : path.posix).isAbsolute(server.command ?? "");
  if (typeof server.command !== "string" || !isAbsolute) throw new McpError("MCP_COMMAND_NOT_ABSOLUTE", "the server command must be an absolute path", { remediation: "Resolve the command on PATH first.", unavailable: true });

  const env = minimalEnv(server.env ?? {}, { platform, hostEnv: options.hostEnv ?? process.env });
  let child;
  try {
    child = spawn(server.command, server.args ?? [], { cwd: server.cwd, env, shell: false, windowsHide: true, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    throw unavailableFor(error);
  }

  const pending = new Map();
  const settled = new Set();
  let nextId = 1;
  let closed = false;
  let failure = null;
  let stderr = "";
  let stderrBytes = 0;
  let buffer = Buffer.alloc(0);
  let toolsChanged = false;
  let unsolicited = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const timers = new Set();

  const failAll = (error) => {
    failure ??= error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    options.signal?.removeEventListener?.("abort", onAbort);
    try { child.stdin?.end?.(); } catch { /* closed */ }
    killTree(child);
  };
  const fatal = (error) => { failAll(error); close(); };
  function onAbort() { fatal(new McpError("MCP_ABORTED", "the MCP session was cancelled")); }

  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener?.("abort", onAbort, { once: true });
  if (options.deadlineMs > 0) {
    const timer = setTimeout(() => fatal(new McpError("MCP_DEADLINE", "the MCP session exceeded its overall deadline", { remediation: "Raise the deadline or check that the server responds." })), options.deadlineMs);
    timer.unref?.();
    timers.add(timer);
  }

  const write = (message) => {
    if (closed) return;
    try { child.stdin.write(`${stringifyJson(message)}\n`); } catch { /* the close handler reports it */ }
    // A server that never reads its stdin must not make us queue replies without bound.
    if ((child.stdin?.writableLength ?? 0) > limits.messageBytes) fatal(new McpError("MCP_BACKPRESSURE", "the server is not reading its input", { remediation: "The server was stopped." }));
  };

  function handleFrame(bytes) {
    let message;
    try {
      message = JSON.parse(decoder.decode(bytes).replace(/\r$/, ""));
    } catch {
      return fatal(new McpError("MCP_PROTOCOL", "the server sent a frame that is not valid UTF-8 JSON"));
    }
    if (message === null || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return fatal(new McpError("MCP_PROTOCOL", "the server sent a frame that is not a JSON-RPC 2.0 object"));
    const hasId = Object.hasOwn(message, "id") && message.id !== null;
    if (typeof message.method === "string") {
      if (++unsolicited > limits.maxUnsolicited) return fatal(new McpError("MCP_FLOOD", "the server sent too many unsolicited requests or notifications", { remediation: "The server was stopped." }));
      if (hasId) return write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }); // a server request: never acted upon
      if (message.method === "notifications/tools/list_changed") toolsChanged = true;
      return undefined;
    }
    if (!hasId || (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error"))) return fatal(new McpError("MCP_PROTOCOL", "the server sent a response without a valid id or outcome"));
    const entry = pending.get(message.id);
    if (!entry) return fatal(new McpError("MCP_PROTOCOL", settled.has(message.id) ? "the server answered the same request twice" : "the server answered a request that was never made"));
    pending.delete(message.id);
    settled.add(message.id);
    clearTimeout(entry.timer);
    if (Object.hasOwn(message, "error")) {
      const code = Number.isInteger(message.error?.code) ? message.error.code : 0;
      entry.reject(new McpError("MCP_SERVER_ERROR", `the server returned an error (${code}): ${safe(message.error?.message, 200)}`));
    } else entry.resolve(message.result);
    return undefined;
  }

  child.stdout?.on("data", (chunk) => {
    if (closed) return;
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    for (let newline = buffer.indexOf(0x0a); newline !== -1 && !closed; newline = buffer.indexOf(0x0a)) {
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (frame.length > limits.messageBytes) return fatal(new McpError("MCP_FRAME_TOO_LARGE", `the server sent a message larger than ${limits.messageBytes} bytes`));
      if (frame.length > 0) handleFrame(frame);
    }
    if (!closed && buffer.length > limits.messageBytes) fatal(new McpError("MCP_FRAME_TOO_LARGE", `the server sent a message larger than ${limits.messageBytes} bytes`));
  });
  child.stdout?.on("error", () => {});
  child.stdin?.on?.("error", () => {});
  child.stderr?.on("data", (chunk) => {
    const room = limits.stderrBytes - stderrBytes;
    if (room <= 0) return;
    const slice = Buffer.from(chunk).subarray(0, room);
    stderrBytes += slice.length;
    stderr += slice.toString("utf8");
  });
  child.stderr?.on("error", () => {});
  child.on("error", (error) => { failAll(unavailableFor(error)); close(); });
  child.on("close", (code) => {
    if (!closed) failAll(new McpError("MCP_CRASHED", `the server exited unexpectedly (code ${code ?? "none"})`, { remediation: "Run the server command by hand to see why it stops." }));
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    options.signal?.removeEventListener?.("abort", onAbort);
    killTree(child); // a grandchild can outlive the server: reap the tree
  });

  function request(method, params, timeoutMs = limits.requestTimeoutMs) {
    if (failure) return Promise.reject(failure);
    if (closed) return Promise.reject(new McpError("MCP_CLOSED", "the MCP session is closed"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fatal(new McpError("MCP_TIMEOUT", `the server did not answer ${safe(method, 40)} within ${timeoutMs}ms`, { remediation: "Check that the server is healthy; it was stopped." })), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  const client = {
    pid: child.pid ?? null,
    serverInfo: null,
    protocolVersion: null,
    get toolsChanged() { return toolsChanged; },
    stderr: () => safe(stderr, limits.stderrBytes),
    close,
    async initialize() {
      const result = await request("initialize", { protocolVersion: SUPPORTED_PROTOCOLS[0], capabilities: {}, clientInfo: options.clientInfo ?? { name: "asterweave", version: "0.1.0" } });
      const version = result?.protocolVersion;
      if (typeof version !== "string" || !SUPPORTED_PROTOCOLS.includes(version)) {
        close();
        throw new McpError("MCP_VERSION_UNSUPPORTED", `the server speaks MCP protocol version ${safe(version, 40)}, which this client does not support`, { remediation: `Update the server (supported: ${SUPPORTED_PROTOCOLS.join(", ")}).`, unavailable: true });
      }
      client.protocolVersion = version;
      client.serverInfo = { name: safe(result?.serverInfo?.name, 80), version: safe(result?.serverInfo?.version, 40) };
      write({ jsonrpc: "2.0", method: "notifications/initialized" });
      return client.serverInfo;
    },
    /** @returns {Promise<{tools: Array<{name, description, inputSchema}>, warnings: string[]}>} */
    async listTools() {
      const tools = [];
      const warnings = [];
      const names = new Set();
      let cursor;
      for (let page = 0; page < limits.maxPages; page += 1) {
        const result = await request("tools/list", cursor === undefined ? {} : { cursor });
        const list = Array.isArray(result?.tools) ? result.tools : null;
        if (list === null) throw new McpError("MCP_PROTOCOL", "tools/list returned no tool list");
        for (const raw of list) {
          if (tools.length >= limits.maxTools) { warnings.push(`more than ${limits.maxTools} tools; the rest were ignored`); break; }
          const name = raw?.name;
          if (typeof name !== "string" || !TOOL_NAME.test(name)) { warnings.push("a tool with an invalid name was ignored"); continue; }
          if (names.has(name)) { warnings.push(`duplicate tool ${name} ignored`); continue; }
          let schema = raw.inputSchema;
          if (schema === null || typeof schema !== "object" || Array.isArray(schema)) schema = { type: "object" };
          try {
            if (boundedCanonicalJson(schema).length > limits.schemaChars) throw new Error("big");
          } catch {
            warnings.push(`tool ${name} ignored: its input schema is too large or too deeply nested`);
            continue;
          }
          names.add(name);
          tools.push({ name, description: safe(raw.description, limits.descriptionChars), inputSchema: toPlainData(schema, { maxItems: 1000 }) });
        }
        const next = result.nextCursor;
        if (typeof next !== "string" || next === "" || next.length > limits.cursorChars) return { tools, warnings };
        cursor = next;
      }
      warnings.push(`tools/list has more than ${limits.maxPages} pages; the rest were ignored`);
      return { tools, warnings };
    },
    async callTool(name, args = {}, timeoutMs) {
      if (typeof name !== "string" || !TOOL_NAME.test(name)) throw new McpError("MCP_TOOL_NAME", "invalid tool name");
      const result = await request("tools/call", { name, arguments: args }, timeoutMs);
      return { isError: result?.isError === true, text: flatten(result?.content) };
    },
  };
  return client;
}

function unavailableFor(error) {
  if (error?.code === "ENOENT") return new McpError("MCP_COMMAND_MISSING", "the server command was not found", { remediation: "Install the server or fix its command path.", unavailable: true });
  if (error?.code === "EACCES") return new McpError("MCP_COMMAND_DENIED", "the server command is not executable", { remediation: "Check the file permissions of the command.", unavailable: true });
  return new McpError("MCP_SPAWN_FAILED", `the server could not be started (${safe(error?.code ?? error?.name, 40)})`, { remediation: "Run the server command by hand to see why it fails.", unavailable: true });
}
