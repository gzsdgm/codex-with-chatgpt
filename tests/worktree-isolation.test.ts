import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireTaskLease,
  assertAuditMode,
  assertMainWorktreeReadOnly,
  assertTaskRegistrationReady,
  assertTaskExecutionReady,
  canonicalizeRepoPath,
  createTaskWorktree,
  isMainWorktree,
  inspectTaskScope,
  readExecutionSummary,
  readTaskRegistry,
  registerTask,
  releaseTaskLease,
  taskLeasePath,
  worktreeLeasePath,
  taskRegistryPath,
  withAuthorizedTaskExecution,
  writeExecutionSummary,
  type TaskRegistrationInput,
} from "../src/task/isolation.js";
import { cleanup, git, makeGitRepo, write } from "./helpers.js";

let tempRoot: string;
let repo: string;
let worktree: string;
let secondWorktree: string;
let stateDir: string;
let baseline: string;
let task: TaskRegistrationInput;

function isWithinFixtureRoot(target: string): boolean {
  const relative = path.relative(tempRoot, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertFixtureContainment(target: string): string {
  const resolved = path.resolve(target);
  if (!isWithinFixtureRoot(resolved)) throw new Error(`TEST_FIXTURE_CONTAINMENT_FAILED: ${target}`);

  let current = resolved;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      const canonical = suffix.length > 0 ? path.join(real, ...suffix) : real;
      if (!isWithinFixtureRoot(canonical)) throw new Error(`TEST_FIXTURE_CONTAINMENT_FAILED: ${target}`);
      return canonical;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TEST_FIXTURE_CONTAINMENT_FAILED")) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`TEST_FIXTURE_CONTAINMENT_FAILED: ${target}`);
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

function fixturePath(relative: string): string {
  return assertFixtureContainment(path.join(tempRoot, relative));
}

function fixtureGit(cwd: string, ...args: string[]): string {
  assertFixtureContainment(cwd);
  for (const arg of args) {
    if (path.isAbsolute(arg)) assertFixtureContainment(arg);
  }
  return git(cwd, ...args);
}

function fixtureWrite(dir: string, relative: string, content: string): string {
  assertFixtureContainment(path.resolve(dir, relative));
  return write(dir, relative, content);
}

function registerInput(taskId = "ISO-A", overrides: Partial<TaskRegistrationInput> = {}): TaskRegistrationInput {
  return {
    taskId,
    workspaceRoot: repo,
    workspaceName: path.basename(repo),
    baselineHead: baseline,
    worktreeRoot: worktree,
    branch: `task/${taskId}`,
    allowedFiles: ["src/index.ts"],
    acceptanceCommands: ["pnpm test"],
    iteration: 0,
    ...overrides,
  };
}

beforeEach(() => {
  tempRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "c2c-isolation-test-")));
  stateDir = fixturePath("state");
  repo = fixturePath("fixture-main");
  const worktreeParent = fixturePath("fixture-task-worktrees");
  worktree = assertFixtureContainment(path.join(worktreeParent, "fixture-task-worktree"));
  secondWorktree = assertFixtureContainment(path.join(worktreeParent, "fixture-task-worktree-2"));
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(worktreeParent, { recursive: true });
  makeGitRepo(repo);
  baseline = fixtureGit(repo, "rev-parse", "HEAD").trim();
  fixtureGit(repo, "worktree", "add", "-b", "task/ISO-A", worktree, baseline);
  task = registerInput();
  process.env.C2C_STATE_DIR = stateDir;
  process.env.C2C_WORKTREE_ROOT = worktreeParent;
});

afterEach(() => {
  try {
    fixtureGit(repo, "worktree", "remove", "--force", worktree);
  } catch {
    // The fixture may have been removed by a failed setup.
  }
  try {
    fixtureGit(repo, "worktree", "remove", "--force", secondWorktree);
  } catch {
    // The second fixture is only created by the concurrency test.
  }
  cleanup(tempRoot);
  delete process.env.C2C_STATE_DIR;
  delete process.env.C2C_WORKTREE_ROOT;
});

describe("task worktree isolation", () => {
  it("rejects every mutation operation on the fixture MAIN path", () => {
    const originalRealpath = fs.realpathSync.native.bind(fs.realpathSync);
    const realpathSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((input) => {
      const candidate = path.resolve(input.toString());
      return isWithinFixtureRoot(candidate) ? originalRealpath(candidate) : repo;
    });
    try {
      expect(isMainWorktree(repo)).toBe(true);
      for (const operation of ["write", "patch", "shell_mutation", "git_write", "test_mutation"] as const) {
        expect(() => assertMainWorktreeReadOnly(repo, operation)).toThrow("MAIN_WORKTREE_READ_ONLY");
      }
      expect(() => assertAuditMode(repo, "git_status")).not.toThrow();
      expect(() => assertAuditMode(repo, "write")).toThrow("MAIN_WORKTREE_READ_ONLY");
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("fails closed when a target escapes the fixture TEMP_ROOT", () => {
    expect(() => assertFixtureContainment(path.join(tempRoot, "..", "outside"))).toThrow(
      "TEST_FIXTURE_CONTAINMENT_FAILED"
    );
  });

  it("requires a registered task before execution", () => {
    expect(() => assertTaskExecutionReady({
      taskId: "missing",
      workspaceName: "missing",
      workspaceRoot: repo,
      worktreeRoot: worktree,
    })).toThrow("TASK_NOT_REGISTERED");
  });

  it("persists the complete registry and rereads it after a fresh access", () => {
    const registered = registerTask(task);
    expect(registered.status).toBe("REGISTERED");
    expect(JSON.parse(fs.readFileSync(taskRegistryPath(task.taskId), "utf8"))).toMatchObject({
      taskId: "ISO-A",
      workspaceName: path.basename(repo),
      workspaceRoot: registered.workspaceRoot,
      repoRoot: registered.repoRoot,
      repoId: registered.repoId,
      baselineHead: baseline,
      worktreeRoot: registered.worktreeRoot,
      branch: "task/ISO-A",
      allowedFiles: ["src/index.ts"],
      acceptanceCommands: ["pnpm test"],
      iteration: 0,
      status: "REGISTERED",
    });
    expect(readTaskRegistry("ISO-A")).toEqual(registered);
  });

  it("rejects a worktree, branch, or baseline mismatch", () => {
    registerTask(task);
    expect(() => assertTaskExecutionReady({
      taskId: task.taskId,
      workspaceName: path.basename(repo),
      workspaceRoot: repo,
      worktreeRoot: secondWorktree,
    })).toThrow("WORKTREE_MISMATCH");

    fixtureGit(worktree, "switch", "-c", "task/ISO-OTHER");
    expect(() => assertTaskExecutionReady({
      taskId: task.taskId,
      workspaceName: path.basename(repo),
      workspaceRoot: repo,
      worktreeRoot: worktree,
    })).toThrow("BRANCH_MISMATCH");

    fixtureGit(worktree, "switch", "task/ISO-A");
    fixtureWrite(worktree, "src/index.ts", "export const answer = 43;\n");
    fixtureGit(worktree, "add", ".");
    fixtureGit(worktree, "commit", "-m", "fixture baseline drift");
    expect(() => assertTaskExecutionReady({
      taskId: task.taskId,
      workspaceName: path.basename(repo),
      workspaceRoot: repo,
      worktreeRoot: worktree,
    })).toThrow("BASELINE_MISMATCH");
  });

  it("rejects a second task that tries to bind the same worktree", () => {
    registerTask(task);
    expect(() => registerTask(registerInput("ISO-B"))).toThrow("WORKTREE_ALREADY_REGISTERED");
  });

  it("allows only one active owner for a task and one owner per worktree", () => {
    registerTask(task);
    const lease = acquireTaskLease(task.taskId, "owner-a");
    expect(() => acquireTaskLease(task.taskId, "owner-b")).toThrow("TASK_LEASE_CONFLICT");
    releaseTaskLease(lease);

    fixtureGit(repo, "worktree", "add", "-b", "task/ISO-B", secondWorktree, baseline);
    registerTask(registerInput("ISO-B", { worktreeRoot: secondWorktree }));
    const first = acquireTaskLease("ISO-A", "owner-a");
    const other = acquireTaskLease("ISO-B", "owner-b");
    releaseTaskLease(first);
    releaseTaskLease(other);
    const second = acquireTaskLease("ISO-B", "owner-b-2");
    releaseTaskLease(second);
  });

  it("uses the production authorization wrapper and holds both leases during execution", () => {
    registerTask(task);
    let leasesObserved = false;
    const result = withAuthorizedTaskExecution(
      { taskId: task.taskId, workspaceName: path.basename(repo), workspaceRoot: repo, worktreeRoot: worktree },
      () => {
        leasesObserved = fs.existsSync(taskLeasePath(task.taskId)) && fs.existsSync(worktreeLeasePath(worktree));
        return "authorized";
      },
      "production-owner"
    );
    expect(result).toBe("authorized");
    expect(leasesObserved).toBe(true);
    expect(fs.existsSync(taskLeasePath(task.taskId))).toBe(false);
    expect(fs.existsSync(worktreeLeasePath(worktree))).toBe(false);
  });

  it("identifies tracked scope violations and reports untracked files", () => {
    registerTask(task);
    fixtureWrite(worktree, "hello.txt", "out of scope\n");
    fixtureWrite(worktree, "scratch.txt", "untracked\n");
    const report = inspectTaskScope(task.taskId, worktree);
    expect(report.status).toBe("SCOPE_VIOLATION");
    expect(report.outsideTracked).toContain("hello.txt");
    expect(report.untracked).toContain("scratch.txt");
    expect(report.finalStatus).toContain("hello.txt");
    expect(report.finalDiff).toContain("out of scope");
  });

  it("reports ignored files separately from ordinary untracked files", () => {
    registerTask(task);
    fixtureWrite(worktree, ".gitignore", "*.ignored\n");
    fixtureWrite(worktree, "ordinary.txt", "ordinary\n");
    fixtureWrite(worktree, "secret.ignored", "ignored\n");
    const report = inspectTaskScope(task.taskId, worktree);
    expect(report.untracked).toContain(".gitignore");
    expect(report.untracked).toContain("ordinary.txt");
    expect(report.ignoredFiles).toContain("secret.ignored");
  });

  it("rejects same-name workspace identity with a different root or repository", () => {
    registerTask(task);
    const otherRepo = fixturePath("fixture-other-repo");
    fs.mkdirSync(otherRepo, { recursive: true });
    makeGitRepo(otherRepo);
    fixtureWrite(otherRepo, ".c2c.json", JSON.stringify({ name: path.basename(repo) }));
    try {
      expect(() => assertTaskExecutionReady({
        taskId: task.taskId,
        workspaceName: path.basename(repo),
        workspaceRoot: otherRepo,
        worktreeRoot: worktree,
      })).toThrow("WORKSPACE_IDENTITY_MISMATCH");
    } finally {
      cleanup(otherRepo);
    }
  });

  it("persists and rereads the execution summary fields", () => {
    registerTask(task);
    const lease = acquireTaskLease(task.taskId, "summary-owner");
    const summary = writeExecutionSummary({
      taskId: task.taskId,
      iteration: 1,
      worktreeRoot: worktree,
      branch: task.branch,
      baselineHead: baseline,
      allowedFiles: task.allowedFiles,
      testsActuallyRun: "fixture test: 1 passed",
      finalDiff: "diff --git a/src/index.ts b/src/index.ts",
      finalStatus: " M src/index.ts",
      status: "EXECUTED",
      recordedAt: new Date().toISOString(),
    });
    expect(readExecutionSummary(task.taskId)).toEqual(summary);
    expect(readTaskRegistry(task.taskId)).toMatchObject({ status: "EXECUTED", iteration: 1 });
    expect(summary).toMatchObject({
      taskId: "ISO-A",
      iteration: 1,
      worktreeRoot: worktree,
      branch: "task/ISO-A",
      baselineHead: baseline,
      allowedFiles: ["src/index.ts"],
      testsActuallyRun: "fixture test: 1 passed",
      finalStatus: " M src/index.ts",
    });
    releaseTaskLease(lease);
  });

  it("rejects invalid status and requires both persisted leases for execution", () => {
    const registered = registerTask(task);
    expect(assertTaskRegistrationReady({ taskId: task.taskId, workspaceName: registered.workspaceName, workspaceRoot: repo, worktreeRoot: worktree })).toEqual(registered);
    expect(() => assertTaskExecutionReady({ taskId: task.taskId, workspaceName: registered.workspaceName, workspaceRoot: repo, worktreeRoot: worktree })).toThrow("TASK_LEASE_REQUIRED");
    fs.writeFileSync(taskRegistryPath(task.taskId), JSON.stringify({ ...registered, status: "FAILED" }));
    expect(() => assertTaskRegistrationReady({ taskId: task.taskId, workspaceName: registered.workspaceName, workspaceRoot: repo, worktreeRoot: worktree })).toThrow("TASK_STATUS_NOT_ALLOWED");
  });

  it("persists lease ownership, rejects duplicate owners, and explicitly recovers expiry", () => {
    registerTask(task);
    const acquiredAt = new Date("2026-01-01T00:00:00.000Z");
    const lease = acquireTaskLease(task.taskId, "owner-a", { ttlMs: 1000, now: acquiredAt });
    expect(JSON.parse(fs.readFileSync(taskLeasePath(task.taskId), "utf8"))).toMatchObject({ taskId: task.taskId, ownerId: "owner-a", expiresAt: "2026-01-01T00:00:01.000Z" });
    expect(fs.existsSync(worktreeLeasePath(worktree))).toBe(true);
    expect(() => acquireTaskLease(task.taskId, "owner-b", { now: acquiredAt })).toThrow("TASK_LEASE_CONFLICT");
    const expired = acquireTaskLease(task.taskId, "owner-b", {
      recoverStale: true,
      now: new Date("2026-01-01T00:01:00.000Z"),
    });
    releaseTaskLease(expired);
    expect(() => releaseTaskLease(lease)).toThrow("TASK_LEASE_NOT_FOUND");
  });

  it("fails closed on a corrupted persisted lease", () => {
    registerTask(task);
    fs.mkdirSync(path.dirname(taskLeasePath(task.taskId)), { recursive: true });
    fs.writeFileSync(taskLeasePath(task.taskId), "not-json");
    expect(() => acquireTaskLease(task.taskId, "owner-b")).toThrow("TASK_LEASE_CORRUPT");
  });

  it("canonicalizes mixed path forms and rejects repository escapes", () => {
    expect(canonicalizeRepoPath(worktree, "src\\index.ts")).toBe(canonicalizeRepoPath(worktree, "./src/index.ts"));
    expect(canonicalizeRepoPath(worktree, "src/index.ts")).toBe(canonicalizeRepoPath(worktree, "SRC\\INDEX.TS"));
    expect(() => canonicalizeRepoPath(worktree, "..\\outside.ts")).toThrow("PATH_OUTSIDE_REPOSITORY");
    const syntheticAbsolutePath = "C:\\outside.ts";
    expect(path.win32.isAbsolute(syntheticAbsolutePath)).toBe(true);
  });

  it("rejects a physical symlink escape below the configured worktree root", () => {
    const allowedRoot = path.dirname(worktree);
    const outside = fixturePath("fixture-symlink-target");
    const link = fixturePath("fixture-physical-link");
    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      cleanup(outside);
      return;
    }
    try {
      expect(() => createTaskWorktree({
        ...task,
        taskId: "ISO-LINK",
        branch: "task/ISO-LINK",
        worktreeRoot: path.join(link, "ISO-LINK"),
      })).toThrow("PHYSICAL_PATH_ESCAPE");
    } finally {
      cleanup(outside);
      cleanup(link);
    }
  });

  it("can create a dedicated task worktree from a temporary repository", () => {
    const newRoot = fixturePath("fixture-created-worktrees");
    const newWorktree = path.join(newRoot, "ISO-C");
    assertFixtureContainment(newWorktree);
    process.env.C2C_WORKTREE_ROOT = newRoot;
    const created = createTaskWorktree({
      ...task,
      taskId: "ISO-C",
      branch: "task/ISO-C",
      worktreeRoot: newWorktree,
    });
    expect(created.status).toBe("REGISTERED");
    expect(readTaskRegistry("ISO-C")?.worktreeRoot).toBe(fs.realpathSync.native(newWorktree));
    expect(fs.realpathSync.native(newWorktree)).toBe(newWorktree);
    fixtureGit(repo, "worktree", "remove", "--force", newWorktree);
  });
});
