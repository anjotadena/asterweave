// Crash recovery of the run loop: event-first persistence, folding, torn tails, half-done side effects, locks.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { appendFileSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import test, { after } from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import { simulatedDispatcher } from "../src/runtime/executor.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { loadRun } from "../src/runtime/ledger.mjs";
import { runLoop } from "../src/runtime/loop.mjs";
import { acquireRunLock, inspectRunLock } from "../src/runtime/lock.mjs";
import { cleanupTemp } from "./repo-fixture.mjs";
import { attempt, baseOptions, deliveryGraph, drive, makeBox, readEvents, script, startRun, tool } from "./loop-fixture.mjs";

after(cleanupTemp);

const graph = deliveryGraph;
const crash = () => Object.assign(new Error("simulated crash"), { code: "EIO" });

function lastType(dir) {
  const lines = readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter((line) => line.trim() !== "");
  return JSON.parse(lines.at(-1)).type;
}

/** An fs that fails ONCE: the run.json rename after an event of `afterEvent`, or the append of an event line containing `onLine`. */
function faultFs(dir, { afterEvent, onLine }) {
  let armed = true;
  return {
    ...nodeFs,
    renameSync(from, to) {
      if (armed && afterEvent && basename(String(to)) === "run.json" && lastType(dir) === afterEvent) {
        armed = false;
        throw crash();
      }
      return nodeFs.renameSync(from, to);
    },
    writeSync(fd, buffer, ...rest) {
      if (armed && onLine && Buffer.isBuffer(buffer) && buffer.toString("utf8").includes(onLine)) {
        armed = false;
        throw crash();
      }
      return nodeFs.writeSync(fd, buffer, ...rest);
    },
  };
}

const writeTool = tool("write", { path: "notes.txt", content: "hello" });
const toolScript = () => script(graph, { intake: attempt(graph, "intake", { before: [writeTool] }) });

test("a crash between the event and the snapshot leaves the run behind by one event; the next run folds it and goes on", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph);
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), fs: faultFs(dir, { afterEvent: "node.entered" }) })), (error) => error.code === "STORE_WRITE_FAILED");
  assert.equal(inspectRunLock(dir).state, "none", "the lock is released even though the run failed");
  const crashed = loadRun(dir);
  assert.equal(crashed.behind, 1);
  assert.equal(crashed.pending[0].type, "node.entered");
  assert.equal(crashed.run.nodes.intake.status, "pending", "the snapshot did not advance");
  assert.equal(crashed.run.nodes.intake.attempts, 0);

  const resumed = await drive(box, dir, graph, steps);
  assert.equal(resumed.final.status, "completed");
  assert.equal(resumed.final.run.nodes.intake.attempts, 1, "the folded enter was not applied a second time");
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.type === "node.entered" && event.node === "intake").length, 1);
  const folded = events.find((event) => event.type === "ledger.folded");
  assert.deepEqual([folded.count, folded.fromSeq], [1, crashed.pending[0].seq]);
  assert.equal(loadRun(dir).behind, 0);
});

test("a crash in the middle of an event group is completed from the first event", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  // A denied command completes the node with two effects: node.completed and run.paused.
  const steps = { v: 1, steps: [{ node: "intake", action: tool("shell", { command: "git reset --hard" }) }] };
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), fs: faultFs(dir, { afterEvent: "node.completed" }) })), (error) => error.code === "STORE_WRITE_FAILED");
  const crashed = loadRun(dir);
  assert.equal(crashed.behind, 1);
  assert.equal(crashed.events.at(-1).type, "node.completed");
  assert.equal(crashed.events.at(-1).tx.n, 2);

  await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps) }));
  const events = readEvents(dir);
  const index = events.findIndex((event) => event.type === "node.completed");
  assert.equal(events[index + 1].type, "ledger.folded");
  assert.equal(events[index + 2].type, "run.paused", "the effect that never reached the log was written");
  assert.deepEqual([events[index + 2].tx.id, events[index + 2].tx.i], [events[index].tx.id, 1]);
  assert.equal(loadRun(dir).behind, 0);
});

test("a torn final line is cut off under the lock and recorded", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph);
  const first = await drive(box, dir, graph, steps, { grant: false });
  assert.equal(first.final.status, "waiting-approval");
  const file = join(dir, "events.jsonl");
  const before = readFileSync(file);
  appendFileSync(file, '{"v":1,"seq":99999,"type":"node.ent');
  assert.equal(loadRun(dir).torn, true);

  const result = await drive(box, dir, graph, steps);
  assert.equal(result.final.status, "completed");
  const loaded = loadRun(dir);
  assert.equal(loaded.torn, false);
  assert.ok(readFileSync(file).subarray(0, before.length).equals(before), "complete lines were not touched");
  const repaired = loaded.events.find((event) => event.type === "ledger.repaired");
  assert.equal(repaired.reason, "torn-tail");
  assert.equal(repaired.seq, before.toString("utf8").split("\n").length, "recorded right after the last complete event");
});

test("started without completed: an idempotent action is run again, in the SAME attempt, and completes once", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = toolScript();
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher, fs: faultFs(dir, { onLine: '"type":"action.completed"' }) })), (error) => error.code === "EIO");
  assert.equal(dispatcher.calls.length, 1);
  const crashed = loadRun(dir).run;
  assert.equal(crashed.status, "active");
  assert.equal(crashed.nodes.intake.status, "running");
  assert.equal(crashed.nodes.intake.attempts, 1);
  assert.deepEqual(readEvents(dir).filter((event) => event.type.startsWith("action.")).map((event) => event.type), ["action.proposed", "action.started"]);

  const resumed = await drive(box, dir, graph, steps, { dispatcher });
  assert.equal(resumed.final.status, "completed");
  assert.equal(dispatcher.calls.length, 2, "the write ran again");
  assert.equal(dispatcher.calls[0].key, dispatcher.calls[1].key, "under the same idempotency key");
  const events = readEvents(dir);
  const recovered = events.filter((event) => event.type === "node.recovered");
  assert.deepEqual(recovered.map((event) => event.reason), ["interrupted-attempt", "IDEMPOTENT_RERUN"]);
  const key = dispatcher.calls[0].key;
  assert.equal(events.filter((event) => event.type === "action.completed" && event.key === key).length, 1, "no duplicate completion");
  assert.equal(resumed.final.run.nodes.intake.attempts, 1, "the interrupted attempt did not consume another one");
  assert.equal(resumed.final.run.nodes.intake.attemptLog.length, 1);
});

test("started and completed but not snapshotted: the action is NOT run again", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = toolScript();
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher, fs: faultFs(dir, { afterEvent: "action.completed" }) })), (error) => error.code === "STORE_WRITE_FAILED");
  assert.equal(loadRun(dir).behind, 1);

  const resumed = await drive(box, dir, graph, steps, { dispatcher });
  assert.equal(resumed.final.status, "completed");
  assert.equal(dispatcher.calls.length, 1);
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.type === "node.recovered" && event.reason !== "interrupted-attempt").length, 0);
  assert.equal(events.filter((event) => event.type === "action.completed").length, 1);
  assert.equal(resumed.final.run.nodes.intake.attempts, 1);
});

test("started without completed and not repeatable: the node stops for a human with SIDE_EFFECT_UNKNOWN", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = script(graph, { intake: attempt(graph, "intake", { before: [tool("shell", { command: "echo deploy-it" })] }) });
  steps.steps.find((step) => step.action.type === "tool").idempotent = false;
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher, fs: faultFs(dir, { onLine: '"type":"action.completed"' }) })), (error) => error.code === "EIO");

  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher }));
  assert.equal(dispatcher.calls.length, 1, "not repeated");
  assert.equal(result.status, "blocked");
  assert.equal(result.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(result.reason, "SIDE_EFFECT_UNKNOWN");
  assert.equal(result.run.nodes.intake.outcome, "needs-human");
  assert.equal(result.run.nodes.intake.attempts, 0, "refunded");
  const events = readEvents(dir);
  assert.ok(events.some((event) => event.type === "node.recovered" && event.reason === "SIDE_EFFECT_UNKNOWN"));
  const completed = events.find((event) => event.type === "node.completed" && event.outcome === "needs-human");
  assert.equal(completed.tx.input.signature, "side-effect-unknown", "the reducer input is kept in the log");
});

test("a second runLoop on a live run is refused with RUN_LOCKED and leaves the first one alone", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph);
  const inner = createFakeExecutor(steps);
  let entered;
  let release;
  const enteredPromise = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  const executor = {
    ...inner,
    async observe(ctx) {
      entered();
      await gate;
      return inner.observe(ctx);
    },
  };
  const first = runLoop(baseOptions(box, dir, graph, { executor }));
  await enteredPromise;
  assert.equal(inspectRunLock(dir).state, "live");
  const seq = loadRun(dir).run.lastSeq;
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps) })), (error) => error.code === "RUN_LOCKED" && error.exitCode === EXIT.ERROR);
  assert.equal(loadRun(dir).run.lastSeq, seq);
  release();
  const result = await first;
  assert.equal(result.status, "waiting-approval");
  assert.equal(inspectRunLock(dir).state, "none");
});

test("a stale lock (its owner is dead) is taken over; a live one is not", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph);
  acquireRunLock(dir, { pid: 987_654 }); // never released: its "process" is gone
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), lockOptions: { pidAlive: () => true } })), (error) => error.code === "RUN_LOCKED");
  assert.equal(readEvents(dir).length, 1, "nothing was written while the lock was live");

  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), lockOptions: { pidAlive: (pid) => pid !== 987_654 } }));
  assert.equal(result.status, "waiting-approval");
  assert.equal(inspectRunLock(dir).state, "none");
});

test("a crash while a plan approval is pending does not lose or duplicate the request", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph);
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), fs: faultFs(dir, { afterEvent: "approval.requested" }) })), (error) => error.code === "STORE_WRITE_FAILED");
  assert.equal(loadRun(dir).run.approvals.length, 0, "the snapshot has not seen the request");
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps) }));
  assert.equal(result.status, "waiting-approval");
  assert.equal(result.run.approvals.length, 1);
  assert.equal(readEvents(dir).filter((event) => event.type === "approval.requested").length, 1);
});

