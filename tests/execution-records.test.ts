import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  appendExecutionRecord,
  beginTask,
  readExecutionRecords,
  readTaskRegistry,
  taskRegistryPath,
  type ExecutionRecord,
  type TaskBeginInput,
} from "../src/execution/records.js";
import { readTaskRegistry as readIsolationTaskRegistry } from "../src/task/isolation.js";
import { cleanup, makeGitRepo, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let stateDir: string;
let workspaceRoot: string;
let gitWorkspace: string;

function taskInput(overrides: Partial<TaskBeginInput> = {}): TaskBeginInput {
  return {
    taskId: "c2c_persist1",
    workspaceId: "workspace-1",
    workspaceRoot,
    iteration: 0,
    baselineHead: "baseline-head",
    allowedFiles: ["src/execution/records.ts"],
    acceptanceCommands: ["pnpm typecheck"],
    stopConditions: ["out of scope"],
    ...overrides,
  };
}

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    taskId: "c2c_persist1",
    iteration: 1,
    changedFiles: ["src/execution/records.ts"],
    tests: "11 passed",
    exitStatus: "ok",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  stateDir = makeTmpDir("execution-state");
  workspaceRoot = makeTmpDir("execution-workspace");
  gitWorkspace = makeTmpDir("execution-git-workspace");
  makeGitRepo(gitWorkspace);
  process.env.C2C_STATE_DIR = stateDir;
});

afterEach(() => {
  cleanup(stateDir);
  cleanup(workspaceRoot);
  cleanup(gitWorkspace);
});

describe("task identity and execution persistence", () => {
  it("writes and rereads the exact task registry fields", () => {
    const input = taskInput();
    const registry = beginTask(input);
    const persisted = JSON.parse(fs.readFileSync(taskRegistryPath(input.workspaceId, input.taskId), "utf8")) as Record<string, unknown>;

    expect(persisted).toMatchObject({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      workspaceRoot: path.resolve(input.workspaceRoot),
      repoRoot: null,
      repoId: null,
      worktreeRoot: null,
      branch: null,
      baselineHead: input.baselineHead,
      allowedFiles: input.allowedFiles,
      acceptanceCommands: input.acceptanceCommands,
      stopConditions: input.stopConditions,
      status: "REGISTERED",
      lease: null,
      executionRecordPersisted: false,
      createdAt: registry.createdAt,
      updatedAt: registry.updatedAt,
    });
    expect(readTaskRegistry(input.workspaceId, input.taskId)).toEqual(registry);
    expect(readIsolationTaskRegistry(input.taskId)).toEqual(registry);
  });

  it("fails with a non-zero CLI exit when task persistence fails", () => {
    const stateFile = path.join(stateDir, "not-a-directory");
    fs.writeFileSync(stateFile, "blocked");
    const result = spawnSync(
      process.execPath,
      [
        path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(projectRoot, "src", "cli", "index.ts"),
        "task",
        "begin",
        "--workspace",
        workspaceRoot,
        "--task",
        "c2c_cli_fail",
        "--iteration",
        "0",
        "--baseline",
        "baseline",
        "--allowed-files",
        "src/a.ts",
        "--acceptance",
        "pnpm test",
        "--stop-conditions",
        "failure",
        "--json",
      ],
      { cwd: projectRoot, encoding: "utf8", env: { ...process.env, C2C_STATE_DIR: stateFile } }
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('"ok":false');
  });

  it("rejects an unregistered task and leaves persistence false", () => {
    const record = execution();
    const workspaceId = "workspace-missing";
    expect(() => appendExecutionRecord(workspaceId, record, workspaceRoot)).toThrow("TASK_NOT_REGISTERED");
    expect(readExecutionRecords(workspaceId)).toEqual([]);
  });

  it("fails closed for a legacy record against a Git workspace without task context", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs"), path.join(projectRoot, "src", "cli", "index.ts"), "record", "--workspace", gitWorkspace, "--task", "missing", "--iteration", "1"],
      { cwd: projectRoot, encoding: "utf8", env: { ...process.env, C2C_STATE_DIR: stateDir } }
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("TASK_CONTEXT_REQUIRED");
  });

  it("rejects task id, workspace, iteration, and corrupt registry mismatches", () => {
    const input = taskInput();
    beginTask(input);
    expect(() => appendExecutionRecord(input.workspaceId, execution({ taskId: "c2c_other" }), workspaceRoot)).toThrow(
      "TASK_NOT_REGISTERED"
    );
    expect(() => appendExecutionRecord(input.workspaceId, execution({ iteration: 2 }), workspaceRoot)).toThrow(
      "TASK_ITERATION_MISMATCH"
    );
    expect(() => appendExecutionRecord(input.workspaceId, execution(), `${workspaceRoot}-other`)).toThrow(
      "TASK_WORKSPACE_ROOT_MISMATCH"
    );

    fs.writeFileSync(taskRegistryPath(input.workspaceId, input.taskId), "not-json");
    expect(() => appendExecutionRecord(input.workspaceId, execution(), workspaceRoot)).toThrow("TASK_REGISTRY_CORRUPT");
  });

  it("fsyncs, rereads, and gates EXECUTED on the persisted execution record", () => {
    const input = taskInput();
    beginTask(input);
    expect(readTaskRegistry(input.workspaceId, input.taskId)?.executionRecordPersisted).toBe(false);

    const record = execution();
    appendExecutionRecord(input.workspaceId, record, workspaceRoot);

    expect(readExecutionRecords(input.workspaceId)).toEqual([record]);
    expect(readTaskRegistry(input.workspaceId, input.taskId)).toMatchObject({
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      iteration: 1,
      status: "EXECUTED",
      executionRecordPersisted: true,
    });
  });
});
