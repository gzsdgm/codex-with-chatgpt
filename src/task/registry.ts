import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";

export class IsolationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "IsolationError";
  }
}

export type TaskStatus =
  | "CREATING"
  | "REGISTERED"
  | "ACTIVE"
  | "EXECUTED"
  | "BLOCKED"
  | "FAILED"
  | "CLOSED"
  | "CANCELLED";

export interface PersistedLeaseState {
  taskLeaseId: string;
  worktreeLeaseId: string;
  taskId: string;
  worktreeRoot: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: string;
}

/** Canonical task identity shared by isolation, CLI, MCP, and execution records. */
export interface TaskRegistry {
  taskId: string;
  workspaceName: string;
  workspaceRoot: string;
  workspaceId: string;
  repoRoot: string | null;
  repoId: string | null;
  worktreeRoot: string | null;
  branch: string | null;
  baselineHead: string;
  allowedFiles: string[];
  acceptanceCommands: string[];
  stopConditions: string[];
  iteration: number;
  status: TaskStatus;
  lease: PersistedLeaseState | null;
  executionRecordPersisted: boolean;
  createdAt: string;
  updatedAt: string;
}

const safeKey = (value: string, code: string): void => {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(code);
};

export function taskRegistryPath(workspaceId: string, taskId: string): string {
  safeKey(workspaceId, "INVALID_WORKSPACE_ID");
  safeKey(taskId, "INVALID_TASK_ID");
  return path.join(getStateDir(), "tasks", workspaceId, `${taskId}.json`);
}

function writeDurableJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
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
      // Preserve the original persistence error.
    }
    throw error;
  }
}

function readRegistryFile(file: string): TaskRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`TASK_REGISTRY_CORRUPT: ${file}`);
  }
  if (!isTaskRegistry(parsed)) throw new Error(`TASK_REGISTRY_INVALID: ${file}`);
  return parsed;
}

export function isTaskRegistry(value: unknown): value is TaskRegistry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TaskRegistry>;
  return (
    typeof candidate.taskId === "string" &&
    typeof candidate.workspaceName === "string" &&
    typeof candidate.workspaceRoot === "string" &&
    typeof candidate.workspaceId === "string" &&
    (candidate.repoRoot === null || typeof candidate.repoRoot === "string") &&
    (candidate.repoId === null || typeof candidate.repoId === "string") &&
    (candidate.worktreeRoot === null || typeof candidate.worktreeRoot === "string") &&
    (candidate.branch === null || typeof candidate.branch === "string") &&
    typeof candidate.baselineHead === "string" &&
    Array.isArray(candidate.allowedFiles) &&
    candidate.allowedFiles.every((item) => typeof item === "string") &&
    Array.isArray(candidate.acceptanceCommands) &&
    candidate.acceptanceCommands.every((item) => typeof item === "string") &&
    Array.isArray(candidate.stopConditions) &&
    candidate.stopConditions.every((item) => typeof item === "string") &&
    Number.isInteger(candidate.iteration) &&
    ["CREATING", "REGISTERED", "ACTIVE", "EXECUTED", "BLOCKED", "FAILED", "CLOSED", "CANCELLED"].includes(candidate.status ?? "") &&
    (candidate.lease === null || isLeaseState(candidate.lease)) &&
    typeof candidate.executionRecordPersisted === "boolean" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string"
  );
}

function isLeaseState(value: unknown): value is PersistedLeaseState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PersistedLeaseState>;
  return [
    candidate.taskLeaseId,
    candidate.worktreeLeaseId,
    candidate.taskId,
    candidate.worktreeRoot,
    candidate.ownerId,
    candidate.acquiredAt,
    candidate.expiresAt,
  ].every((item) => typeof item === "string" && item.length > 0);
}

export function readTaskRegistry(workspaceId: string, taskId: string): TaskRegistry | null {
  const file = taskRegistryPath(workspaceId, taskId);
  if (!fs.existsSync(file)) return null;
  return readRegistryFile(file);
}

export function readAllTaskRegistries(): TaskRegistry[] {
  const root = path.join(getStateDir(), "tasks");
  if (!fs.existsSync(root)) return [];
  const result: TaskRegistry[] = [];
  for (const workspaceId of fs.readdirSync(root, { withFileTypes: true })) {
    if (!workspaceId.isDirectory() || workspaceId.name === "leases") continue;
    for (const entry of fs.readdirSync(path.join(root, workspaceId.name))) {
      if (!entry.endsWith(".json") || entry.endsWith(".summary.json")) continue;
      result.push(readRegistryFile(path.join(root, workspaceId.name, entry)));
    }
  }
  return result;
}

export function readTaskRegistryByTaskId(taskId: string): TaskRegistry | null {
  safeKey(taskId, "INVALID_TASK_ID");
  const matches = readAllTaskRegistries().filter((registry) => registry.taskId === taskId);
  if (matches.length > 1) throw new Error(`TASK_ID_NOT_UNIQUE: ${taskId}`);
  return matches[0] ?? null;
}

export function writeTaskRegistry(registry: TaskRegistry): TaskRegistry {
  if (!isTaskRegistry(registry)) throw new Error("TASK_REGISTRY_INVALID");
  const file = taskRegistryPath(registry.workspaceId, registry.taskId);
  writeDurableJson(file, registry);
  const reread = readRegistryFile(file);
  if (JSON.stringify(reread) !== JSON.stringify(registry)) {
    throw new Error(`TASK_REGISTRY_REREAD_MISMATCH: ${file}`);
  }
  return reread;
}

export function createTaskRegistry(registry: TaskRegistry): TaskRegistry {
  if (!isTaskRegistry(registry)) throw new Error("TASK_REGISTRY_INVALID");
  const file = taskRegistryPath(registry.workspaceId, registry.taskId);
  for (const candidate of readAllTaskRegistries()) {
    if (candidate.taskId === registry.taskId) throw new Error(`TASK_ID_NOT_UNIQUE: ${registry.taskId}`);
  }
  ensureDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch {
    throw new Error(`TASK_ALREADY_REGISTERED: ${registry.taskId}`);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(registry, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const reread = readRegistryFile(file);
  if (JSON.stringify(reread) !== JSON.stringify(registry)) throw new Error(`TASK_REGISTRY_REREAD_MISMATCH: ${file}`);
  return reread;
}

export function updateTaskRegistry(
  registry: TaskRegistry,
  changes: Partial<TaskRegistry> & { status?: TaskStatus }
): TaskRegistry {
  return writeTaskRegistry({
    ...registry,
    ...changes,
    updatedAt: new Date().toISOString(),
  });
}
