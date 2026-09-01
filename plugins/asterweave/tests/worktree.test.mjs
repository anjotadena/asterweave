import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { listWorktrees, removeWorktree, worktreeExists } from "../scripts/worktree.mjs";

function run(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "asterweave-worktree-"));
  run(["-c", "init.defaultBranch=main", "init"], cwd);
  run(["config", "user.email", "test@example.com"], cwd);
  run(["config", "user.name", "Asterweave Test"], cwd);
  writeFileSync(join(cwd, "README.md"), "# Test repo\n");
  run(["add", "README.md"], cwd);
  run(["commit", "-m", "Initial commit"], cwd);
  return cwd;
}

test("lists the main worktree plus any created worker worktree", () => {
  const cwd = repo();
  const worktreePath = join(tmpdir(), `asterweave-worktree-finance-${Date.now()}`);
  run(["worktree", "add", worktreePath, "-b", "asterweave/finance-completion"], cwd);
  try {
    const worktrees = listWorktrees(cwd);
    assert.ok(worktrees.length >= 2);
    const finance = worktrees.find((entry) => entry.branch === "asterweave/finance-completion");
    assert.ok(finance);
    assert.equal(worktreeExists(worktreePath, cwd), true);
  } finally {
    run(["worktree", "remove", "--force", worktreePath], cwd);
  }
});

test("refuses to remove a worktree with uncommitted changes unless forced", () => {
  const cwd = repo();
  const worktreePath = join(tmpdir(), `asterweave-worktree-dirty-${Date.now()}`);
  run(["worktree", "add", worktreePath, "-b", "asterweave/inventory-completion"], cwd);
  writeFileSync(join(worktreePath, "uncommitted.txt"), "draft work\n");
  try {
    assert.throws(() => removeWorktree(worktreePath, { cwd }), /uncommitted changes/);
    assert.equal(worktreeExists(worktreePath, cwd), true);
    const result = removeWorktree(worktreePath, { force: true, cwd });
    assert.equal(result.removed, worktreePath);
    assert.equal(worktreeExists(worktreePath, cwd), false);
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
  }
});

test("removes a clean worktree without needing --force", () => {
  const cwd = repo();
  const worktreePath = join(tmpdir(), `asterweave-worktree-clean-${Date.now()}`);
  run(["worktree", "add", worktreePath, "-b", "asterweave/hris-completion"], cwd);
  const result = removeWorktree(worktreePath, { cwd });
  assert.equal(result.removed, worktreePath);
  assert.equal(worktreeExists(worktreePath, cwd), false);
});

test("worktreeExists is false for a path Git never created", () => {
  const cwd = repo();
  assert.equal(worktreeExists(join(tmpdir(), "never-existed-worktree"), cwd), false);
});
