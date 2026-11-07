import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createInput, decodeKey } from "../src/tui/input.mjs";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(options) {
  const stdin = new PassThrough();
  const input = createInput({ stdin, ...options });
  const events = [];
  input.onKey((event) => events.push(event));
  return { stdin, input, events };
}

test("arrows, enter, tab, backspace and ctrl-c are normalised", async () => {
  const { stdin, events } = harness();
  stdin.write("\x1b[A\x1b[B\r\t\x7f\x03");
  await tick(20);
  assert.deepEqual(events.map((event) => event.name), ["up", "down", "enter", "tab", "backspace", "ctrl-c"]);
});

test("printable characters carry ch and control keys are not chars", async () => {
  const { stdin, events } = harness();
  stdin.write("a/@é");
  await tick(20);
  assert.deepEqual(events, [{ name: "char", ch: "a" }, { name: "char", ch: "/" }, { name: "char", ch: "@" }, { name: "char", ch: "é" }]);
  assert.equal(decodeKey("\x01", { ctrl: true, name: "a" }), null);
  assert.deepEqual(decodeKey("\x03", undefined), { name: "ctrl-c" });
  assert.deepEqual(decodeKey(undefined, { name: "return" }), { name: "enter" });
});

test("a lone Esc is reported after the escape timeout and does not swallow the next key", async () => {
  const { stdin, events } = harness({ escapeCodeTimeout: 10 });
  stdin.write("\x1b");
  await tick(80);
  stdin.write("x");
  await tick(20);
  assert.deepEqual(events, [{ name: "escape" }, { name: "char", ch: "x" }]);
});

test("stream end and close surface a single eof", async () => {
  const { stdin, events } = harness();
  stdin.end();
  stdin.resume();
  await tick(30);
  assert.deepEqual(events, [{ name: "eof" }]);
  stdin.emit("close");
  assert.equal(events.length, 1);
});

test("unsubscribe and close stop delivery", async () => {
  const stdin = new PassThrough();
  const input = createInput({ stdin });
  const seen = [];
  const off = input.onKey((event) => seen.push(event.name));
  stdin.write("a");
  await tick(20);
  off();
  stdin.write("b");
  await tick(20);
  assert.deepEqual(seen, ["char"]);
  input.close();
  assert.equal(stdin.listenerCount("end"), 0);
});
