import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cleanup, git, makeGitRepo, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = path.join(projectRoot, "bin", "c2c.js");

describe("built CLI isolation smoke", () => {
  let repo: string | undefined;
  let state: string | undefined;
  let worktreeRoot: string | undefined;
  let worktree: string | undefined;

  afterEach(() => {
    if (repo && worktree) {
      try {
        git(repo, "worktree", "remove", "--force", worktree);
      } catch {
        // Preserve the smoke result; cleanup is best effort for a fixture.
      }
    }
    if (repo) cleanup(repo);
    if (state) cleanup(state);
    if (worktreeRoot) cleanup(worktreeRoot);
  });

  it("creates and verifies a task using the current built isolation runtime", () => {
    repo = makeTmpDir("built-cli-repo");
    state = makeTmpDir("built-cli-state");
    worktreeRoot = makeTmpDir("built-cli-worktrees");
    worktree = path.join(worktreeRoot, "SMOKE");
    makeGitRepo(repo);
    const baseline = git(repo, "rev-parse", "HEAD").trim();
    const env = { ...process.env, C2C_STATE_DIR: state, C2C_WORKTREE_ROOT: worktreeRoot };
    const create = spawnSync(process.execPath, [bin, "task", "create", "--workspace", repo, "--task", "SMOKE", "--baseline", baseline, "--allowed-files", "src/index.ts", "--acceptance", "pnpm typecheck", "--worktree", worktree, "--json"], { cwd: projectRoot, encoding: "utf8", env });
    expect(create.status).toBe(0);
    expect(create.stdout).toContain('"ok":true');
    expect(create.stdout).toContain('"status":"REGISTERED"');

    const verify = spawnSync(process.execPath, [bin, "task", "verify", "--workspace", repo, "--task", "SMOKE", "--worktree", worktree, "--json"], { cwd: projectRoot, encoding: "utf8", env });
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('"ok":true');
  });
});
