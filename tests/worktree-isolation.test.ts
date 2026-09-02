import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  acquireTaskLease,
  assertAuditMode,
  assertMainWorktreeReadOnly,
  assertTaskRegistrationReady,
  assertTaskExecutionReady,
  canonicalizeRepoPath,
  createTaskWorktree,
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
import { cleanup, git, makeGitRepo, makeTmpDir, write } from "./helpers.js";

let repo: string;
let worktree: string;
let secondWorktree: string;
let stateDir: string;
let baseline: string;
let task: TaskRegistrationInput;

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
  stateDir = makeTmpDir("isolation-state");
  repo = makeTmpDir("isolation-repo");
  const worktreeParent = makeTmpDir("isolation-worktrees");
  worktree = path.join(worktreeParent, "ISO-A");
  secondWorktree = path.join(worktreeParent, "ISO-B");
  makeGitRepo(repo);
  baseline = git(repo, "rev-parse", "HEAD").trim();
  git(repo, "worktree", "add", "-b", "task/ISO-A", worktree, baseline);
  task = registerInput();
  process.env.C2C_STATE_DIR = stateDir;
  process.env.C2C_WORKTREE_ROOT = path.dirname(worktree);
});

afterEach(() => {
  try {
    git(repo, "worktree", "remove", "--force", worktree);
  } catch {
    // The fixture may have been removed by a failed setup.
  }
  try {
    git(repo, "worktree", "remove", "--force", secondWorktree);
  } catch {
    // The second fixture is only created by the concurrency test.
  }
  cleanup(stateDir);
  cleanup(repo);
  cleanup(path.dirname(worktree));
  delete process.env.C2C_WORKTREE_ROOT;
});

describe("task worktree isolation", () => {
  it("rejects every mutation operation on the Trading_Tools MAIN path", () => {
    for (const operation of ["write", "patch", "shell_mutation", "git_write", "test_mutation"] as const) {
      expect(() => assertMainWorktreeReadOnly("D:\\Trading_Tools_MAIN_FF_20260801", operation)).toThrow(
        "MAIN_WORKTREE_READ_ONLY"
      );
    }
    expect(() => assertAuditMode("D:\\Trading_Tools_MAIN_FF_20260801", "git_status")).not.toThrow();
    expect(() => assertAuditMode("D:\\Trading_Tools_MAIN_FF_20260801", "write")).toThrow(
      "MAIN_WORKTREE_READ_ONLY"
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

    git(worktree, "switch", "-c", "task/ISO-OTHER");
    expect(() => assertTaskExecutionReady({
      taskId: task.taskId,
      workspaceName: path.basename(repo),
      workspaceRoot: repo,
      worktreeRoot: worktree,
    })).toThrow("BRANCH_MISMATCH");

    git(worktree, "switch", "task/ISO-A");
    write(worktree, "src/index.ts", "export const answer = 43;\n");
    git(worktree, "add", ".");
    git(worktree, "commit", "-m", "fixture baseline drift");
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

    git(repo, "worktree", "add", "-b", "task/ISO-B", secondWorktree, baseline);
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
    write(worktree, "hello.txt", "out of scope\n");
    write(worktree, "scratch.txt", "untracked\n");
    const report = inspectTaskScope(task.taskId, worktree);
    expect(report.status).toBe("SCOPE_VIOLATION");
    expect(report.outsideTracked).toContain("hello.txt");
    expect(report.untracked).toContain("scratch.txt");
    expect(report.finalStatus).toContain("hello.txt");
    expect(report.finalDiff).toContain("out of scope");
  });

  it("reports ignored files separately from ordinary untracked files", () => {
    registerTask(task);
    write(worktree, ".gitignore", "*.ignored\n");
    write(worktree, "ordinary.txt", "ordinary\n");
    write(worktree, "secret.ignored", "ignored\n");
    const report = inspectTaskScope(task.taskId, worktree);
    expect(report.untracked).toContain(".gitignore");
    expect(report.untracked).toContain("ordinary.txt");
    expect(report.ignoredFiles).toContain("secret.ignored");
  });

  it("rejects same-name workspace identity with a different root or repository", () => {
    registerTask(task);
    const otherRepo = makeTmpDir("isolation-other-repo");
    makeGitRepo(otherRepo);
    write(otherRepo, ".c2c.json", JSON.stringify({ name: path.basename(repo) }));
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
    expect(() => canonicalizeRepoPath(worktree, "C:\\outside.ts")).toThrow("PATH_OUTSIDE_REPOSITORY");
  });

  it("rejects a physical symlink escape below the configured worktree root", () => {
    const allowedRoot = path.dirname(worktree);
    const outside = makeTmpDir("isolation-outside");
    const link = path.join(allowedRoot, "physical-link");
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
    const newRoot = path.join(path.dirname(worktree), "not-yet-existing-root");
    const newWorktree = path.join(newRoot, "ISO-C");
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
    git(repo, "worktree", "remove", "--force", newWorktree);
  });
});
