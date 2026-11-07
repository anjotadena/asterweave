// Differential test: every shape the plugin's handoff `redactText` redacts must also be redacted
// by the CLI's redact.mjs. The plugin module is imported by THIS TEST ONLY (never at runtime).
// Fake credentials are assembled at runtime so no real-looking token sits in the repository.

import assert from "node:assert/strict";
import test from "node:test";
import { redactText as pluginRedact } from "../../../plugins/asterweave/scripts/handoff-state.mjs";
import { isSecretKeyName, maskEmail, maskToken, redactDeep, redactText } from "../src/redact.mjs";

const rep = (text, times) => text.repeat(times);

// [input, substring that must not survive]
const SHAPES = [
  [`token gh${"p"}_${rep("abcdefghij", 4)}`, "abcdefghij"],
  [`gh${"o"}_${rep("Zz9yXx8wVv", 3)}`, "Zz9yXx8wVv"],
  [`gh${"s"}_${rep("Qq1wEe2rTt", 3)}`, "Qq1wEe2rTt"],
  [`gh${"u"}_${rep("Mm3nBb4vCc", 3)}`, "Mm3nBb4vCc"],
  [`gh${"r"}_${rep("Aa5sDd6fGg", 3)}`, "Aa5sDd6fGg"],
  [`${"github_"}${"pat_"}11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz`, "11ABCDEFG"],
  ["Authorization: " + "Bear" + "er abc.def-ghi_jkl1234567890", "abc.def-ghi"],
  ["AK" + "IA" + "IOSFODNN7EXAMPLE", "IOSFODNN7"],
  ["AS" + "IA" + "IOSFODNN7EXAMPL2", "IOSFODNN7"],
  ["ey" + "J" + "hbGciOiJIUzI1NiJ9." + "ey" + "J" + "zdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "hbGciOiJIUzI1NiJ9"],
  ["postgres://admin:hunter2@db.internal:5432/app", "hunter2"],
  ["Server=db;User Id=sa;Password=Pa55w0rd!;", "Pa55w0rd"],
  ["API_KEY=" + "s" + "k-live-0123456789abcdef", "0123456789abcdef"],
  ['client_secret: "abcd1234efgh"', "abcd1234efgh"],
  ["--password hunter2", "hunter2"],
  ["--token=abcdef123456", "abcdef123456"],
  ["contact jane.doe@example.com", "jane.doe"],
  ["xo" + "xb-1234567890-abcdefghij", "1234567890"],
  ["xo" + "xp-1234567890-abcdefghij", "1234567890"],
  ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
  ["-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF\n-----END PGP PRIVATE KEY BLOCK-----", "lQOYBF"],
  ["-----BEGIN PRIVATE KEY-----\nORPHANBODY", "ORPHANBODY"],
  ["ORPHANBODY2\n-----END PRIVATE KEY-----", "ORPHANBODY2"],
  ["DB_PASSWORD=hunter2secret", "hunter2secret"],
  ["POSTGRES_PASSWORD: abcdef123", "abcdef123"],
  ["MY_APP_DB_PASSWORD=qwerty99", "qwerty99"],
  ["Jwt__Key=mysigningkey", "mysigningkey"],
  ["AWS_SECRET_ACCESS_KEY = wJalrXUtnFEMI", "wJalrXUtnFEMI"],
  [`np${"m"}_${rep("a1", 18)}`, "a1a1a1a1"],
  [`glp${"at"}-${rep("b2", 12)}`, "b2b2b2b2"],
  [`AI${"za"}${rep("c3", 18)}`, "c3c3c3c3"],
  ["Password=ab,cd;Host=x", "ab,cd"],
  ["postgres://admin:ab/cd@db.internal:5432/app", "ab/cd"],
  ["s" + "k-" + "ant-api03-" + "abcdefghijklmnop1234", "abcdefghijklmnop1234"],
];

const UNCHANGED = [
  "remote git@github.com:acme/app.git",
  "12 passed, 0 failed",
  "Add Basic authentication and Bearer authentication middleware",
  "plain text with no secrets at all",
];

test("every shape the plugin redacts is redacted here too (differential)", () => {
  for (const [input, secret] of SHAPES) {
    const theirs = pluginRedact(input);
    const ours = redactText(input);
    assert.ok(theirs.count > 0, `fixture should be redacted by the plugin: ${input.slice(0, 30)}`);
    assert.ok(ours.count > 0, `not redacted: ${input.slice(0, 30)}`);
    assert.ok(!ours.text.includes(secret), `leaked ${secret} from ${input.slice(0, 30)} -> ${ours.text}`);
    assert.ok(!theirs.text.includes(secret), "sanity: plugin also removes the secret");
  }
});

test("inputs the plugin leaves alone are left alone here", () => {
  for (const input of UNCHANGED) {
    assert.equal(pluginRedact(input).count, 0);
    assert.deepEqual(redactText(input), { text: input, count: 0 }, input);
  }
});

test("token-shaped values keep only their prefix", () => {
  const ghp = `gh${"p"}_${rep("abcdefghij", 4)}`;
  assert.equal(redactText(`token ${ghp}`).text, "token ghp_…");
  assert.equal(redactText("s" + "k-" + "ant-api03-" + "abcdefghijklmnop1234").text, "sk-ant-…");
  assert.equal(redactText("AK" + "IA" + "IOSFODNN7EXAMPLE").text, "AKIA…");
  assert.equal(redactText("ey" + "Jhbgcioij.abcdefghi.abcdefghi").text, "eyJ…");
  assert.equal(redactText("Authorization: Bear" + "er abc.def-ghi_jkl1234567890").text, "Authorization: Bearer …");
  assert.equal(maskToken(ghp), "ghp_…");
  assert.equal(maskToken("not a token"), "…");
});

test("emails are masked, not removed", () => {
  assert.equal(maskEmail("anjo@gmail.com"), "an***@g***.com");
  assert.equal(maskEmail("a@b.io"), "a***@b***.io");
  assert.equal(maskEmail("jane.doe@mail.example.co.uk"), "ja***@m***.uk");
  assert.equal(maskEmail("nonsense"), "***");
  assert.equal(redactText("contact anjo@gmail.com now").text, "contact an***@g***.com now");
  assert.equal(redactText("git@github.com:o/n.git").count, 0);
});

test("redactDeep walks objects and arrays without mutating the input", () => {
  const secret = `gh${"p"}_${rep("abcdefghij", 4)}`;
  const input = { a: [`x ${secret}`, 1, null], b: { c: "anjo@gmail.com" } };
  const { value, count } = redactDeep(input);
  assert.equal(count, 2);
  assert.deepEqual(value, { a: ["x ghp_…", 1, null], b: { c: "an***@g***.com" } });
  assert.ok(input.a[0].includes(secret));
  assert.deepEqual(redactText(42), { text: 42, count: 0 });
});

test("isSecretKeyName flags secret-like names only", () => {
  for (const name of ["token", "github.token", "API_KEY", "clientSecret", "db.password", "private-key"]) assert.ok(isSecretKeyName(name), name);
  for (const name of ["runner", "github.host", "ui.color"]) assert.ok(!isSecretKeyName(name), name);
});

test("redaction stays linear on hostile input", () => {
  for (const hostile of [rep("eyJ-", 80_000), rep("a-", 160_000), rep("a.", 160_000), rep("DB_", 100_000)]) {
    const started = Date.now();
    redactText(hostile);
    assert.ok(Date.now() - started < 2000, "redaction must stay linear on hostile input");
  }
});
