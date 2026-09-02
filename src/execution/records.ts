import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir } from "../config/paths.js";
import {
  createTaskRegistry,
  readTaskRegistry as readCanonicalTaskRegistry,
  taskRegistryPath as canonicalTaskRegistryPath,
  updateTaskRegistry,
  type TaskRegistry,
} from "../task/registry.js";

export type { TaskRegistry } from "../task/registry.js";

/**
 * Lightweight execution records written by the Codex harness after each
 * iteration (via `c2c record`). ChatGPT reads them through the
 * `execution_summary` and `test_status` MCP tools.
 */
export interface ExecutionRecord {
  taskId: string;
  iteration: number;
  changedFiles: string[] | number;
  tests: string | null;
  exitStatus: "ok" | "failed" | "blocked" | string;
  timestamp: string;
  notes?: string;
}

export interface TaskBeginInput {
  taskId: string;
  workspaceId: string;
  workspaceRoot: string;
  iteration: number;
  baselineHead: string;
  allowedFiles: string[];
  acceptanceCommands: string[];
  stopConditions: string[];
}

function taskRegistryFile(workspaceId: string, taskId: string): string {
  return canonicalTaskRegistryPath(workspaceId, taskId);
}

export function taskRegistryPath(workspaceId: string, taskId: string): string {
  return taskRegistryFile(workspaceId, taskId);
}

function writeDurableJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Preserve the persistence error.
    }
    throw error;
  }
}

export function beginTask(input: TaskBeginInput): TaskRegistry {
  if (!Number.isInteger(input.iteration) || input.iteration < 0) throw new Error("INVALID_TASK_ITERATION");
  if (!input.taskId || !input.workspaceId || !input.workspaceRoot || !input.baselineHead) {
    throw new Error("INVALID_TASK_REGISTRATION");
  }
  const file = taskRegistryFile(input.workspaceId, input.taskId);
  const now = new Date().toISOString();
  const registry: TaskRegistry = {
    taskId: input.taskId,
    workspaceName: path.basename(input.workspaceRoot),
    workspaceRoot: path.resolve(input.workspaceRoot),
    workspaceId: input.workspaceId,
    repoRoot: null,
    repoId: null,
    worktreeRoot: null,
    branch: null,
    baselineHead: input.baselineHead,
    allowedFiles: input.allowedFiles,
    acceptanceCommands: input.acceptanceCommands,
    stopConditions: input.stopConditions,
    iteration: input.iteration,
    status: "REGISTERED",
    lease: null,
    executionRecordPersisted: false,
    createdAt: now,
    updatedAt: now,
  };
  const reread = createTaskRegistry(registry);
  if (
    reread.taskId !== input.taskId ||
    reread.workspaceId !== input.workspaceId ||
    reread.workspaceRoot !== input.workspaceRoot ||
    reread.iteration !== input.iteration ||
    reread.baselineHead !== input.baselineHead ||
    JSON.stringify(reread.allowedFiles) !== JSON.stringify(input.allowedFiles) ||
    JSON.stringify(reread.acceptanceCommands) !== JSON.stringify(input.acceptanceCommands) ||
    JSON.stringify(reread.stopConditions) !== JSON.stringify(input.stopConditions) ||
    reread.status !== "REGISTERED" ||
    reread.executionRecordPersisted
  ) {
    throw new Error(`TASK_REGISTRY_REREAD_MISMATCH: ${file}`);
  }
  return reread;
}

export function readTaskRegistry(workspaceId: string, taskId: string): TaskRegistry | null {
  return readCanonicalTaskRegistry(workspaceId, taskId);
}

function recordsFile(workspaceId: string): string {
  return path.join(getStateDir(), "executions", `${workspaceId}.jsonl`);
}

export function appendExecutionRecord(workspaceId: string, record: ExecutionRecord, workspaceRoot?: string): void {
  const registry = readTaskRegistry(workspaceId, record.taskId);
  if (!registry) throw new Error(`TASK_NOT_REGISTERED: ${record.taskId}`);
  if (registry.workspaceId !== workspaceId) throw new Error("TASK_WORKSPACE_MISMATCH");
  if (workspaceRoot !== undefined && path.resolve(registry.workspaceRoot).toLowerCase() !== path.resolve(workspaceRoot).toLowerCase()) {
    throw new Error("TASK_WORKSPACE_ROOT_MISMATCH");
  }
  if ((registry.status !== "REGISTERED" && registry.status !== "ACTIVE") || registry.executionRecordPersisted) {
    throw new Error(`TASK_NOT_EXECUTABLE: ${record.taskId}`);
  }
  if (record.iteration !== registry.iteration + 1) {
    throw new Error(`TASK_ITERATION_MISMATCH: expected ${registry.iteration + 1}, got ${record.iteration}`);
  }
  const file = recordsFile(workspaceId);
  ensureDir(path.dirname(file));
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + "\n", "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const reread = latestExecutionRecord(workspaceId);
  if (
    !reread ||
    reread.taskId !== record.taskId ||
    reread.iteration !== record.iteration ||
    JSON.stringify(reread.changedFiles) !== JSON.stringify(record.changedFiles) ||
    reread.tests !== record.tests ||
    reread.exitStatus !== record.exitStatus
  ) {
    throw new Error(`EXECUTION_RECORD_REREAD_MISMATCH: ${file}`);
  }

  const registryReread = updateTaskRegistry(registry, {
    iteration: record.iteration,
    status: "EXECUTED",
    executionRecordPersisted: true,
  });
  if (
    registryReread.taskId !== record.taskId ||
    registryReread.workspaceId !== workspaceId ||
    registryReread.iteration !== record.iteration ||
    registryReread.status !== "EXECUTED" ||
    !registryReread.executionRecordPersisted
  ) {
    throw new Error(`TASK_REGISTRY_EXECUTED_REREAD_MISMATCH: ${taskRegistryFile(workspaceId, record.taskId)}`);
  }
}

export function readExecutionRecords(workspaceId: string, limit = 10): ExecutionRecord[] {
  const file = recordsFile(workspaceId);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const records: ExecutionRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line) as ExecutionRecord);
    } catch {
      // skip corrupt lines
    }
  }
  return records;
}

export function latestExecutionRecord(workspaceId: string): ExecutionRecord | null {
  const records = readExecutionRecords(workspaceId, 1);
  return records[records.length - 1] ?? null;
}
