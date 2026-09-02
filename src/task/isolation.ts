import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ensureDir, getStateDir } from "../config/paths.js";
import { Workspace } from "../workspace/manager.js";
import { parsePorcelainStatus, runGit, type GitCommandResult } from "../workspace/git.js";
import { authorizeControlPlane, authorizeMutation } from "./authorization.js";
import {
  createTaskRegistry,
  readAllTaskRegistries,
  readTaskRegistryByTaskId,
  taskRegistryPath as canonicalTaskRegistryPath,
  updateTaskRegistry,
  type PersistedLeaseState,
  type TaskRegistry,
  type TaskStatus,
  IsolationError,
} from "./registry.js";

export { IsolationError };
export type { PersistedLeaseState, TaskRegistry, TaskStatus } from "./registry.js";

export const DEFAULT_MAIN_WORKTREE_ROOT = "D:\\Trading_Tools_MAIN_FF_20260801";
export const DEFAULT_TASK_WORKTREE_ROOT = "D:\\Trading_Tools_WORKTREES";

export type MutationOperation = "write" | "patch" | "shell_mutation" | "git_write" | "test_mutation";
export type AuditOperation =
  | "workspace_info"
  | "git_status"
  | "git_diff"
  | "read"
  | "search"
  | "test_status"
  | "execution_summary";

export interface TaskRegistrationInput {
  taskId: string;
  workspaceRoot: string;
  workspaceName?: string;
  repoRoot?: string;
  repoId?: string;
  baselineHead: string;
  worktreeRoot: string;
  branch: string;
  allowedFiles: string[];
  acceptanceCommands: string[];
  stopConditions?: string[];
  iteration?: number;
}

interface RepoIdentity {
  repoRoot: string;
  repoId: string;
  head: string;
  branch: string;
}

export interface TaskExecutionValidation {
  taskRegistered: boolean;
  workspaceNameMatch: boolean;
  workspaceRootMatch: boolean;
  repoRootMatch: boolean;
  repoIdentityMatch: boolean;
  gitRootMatch: boolean;
  worktreeMatch: boolean;
  branchMatch: boolean;
  baselineMatch: boolean;
  statusAllowed: boolean;
  taskLeaseHeld: boolean;
  worktreeLeaseHeld: boolean;
  verificationFailed: boolean;
  registry?: TaskRegistry;
}

export interface TaskScopeReport {
  taskId: string;
  status: "PASS" | "SCOPE_VIOLATION" | "UNTRACKED_FILES_PRESENT" | "SCOPE_VERIFICATION_FAILED";
  allowedFiles: string[];
  trackedModified: string[];
  outsideTracked: string[];
  untracked: string[];
  ignoredFiles: string[];
  finalDiff: string;
  finalStatus: string;
}

export interface TaskLease extends PersistedLeaseState { leaseId: string; }

export interface LeaseOptions {
  ttlMs?: number;
  recoverStale?: boolean;
  now?: Date;
}

export interface TaskExecutionSummary {
  taskId: string;
  iteration: number;
  worktreeRoot: string;
  branch: string;
  baselineHead: string;
  allowedFiles: string[];
  testsActuallyRun: string | null;
  finalDiff: string;
  finalStatus: string;
  status: string;
  recordedAt: string;
}

const safeTaskId = (taskId: string): void => {
  if (!/^[a-zA-Z0-9._-]+$/.test(taskId)) throw new IsolationError("INVALID_TASK_ID", taskId);
};

const canonicalExisting = (input: string, code: string): string => {
  try {
    const resolved = fs.realpathSync.native(path.resolve(input));
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw new IsolationError(code, input);
  }
};

const samePath = (left: string, right: string): boolean => {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "") || path.parse(path.resolve(value)).root;
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
};

function canonicalDeepPath(input: string): string {
  let current = path.resolve(input);
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return suffix.length > 0 ? path.join(real, ...suffix) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Canonicalize a path and fail closed when it escapes the repository. */
export function canonicalizeRepoPath(repoRoot: string, requested: string): string {
  if (typeof requested !== "string" || requested.includes("\0")) throw new IsolationError("PATH_OUTSIDE_REPOSITORY", requested);
  const repo = canonicalExisting(repoRoot, "REPOSITORY_NOT_FOUND");
  const normalized = requested.trim().replace(/[\\/]+/g, path.sep) || ".";
  const resolved = canonicalDeepPath(path.resolve(repo, normalized));
  const relative = path.relative(repo, resolved);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return resolved;
  throw new IsolationError("PATH_OUTSIDE_REPOSITORY", requested);
}

function canonicalRelative(repoRoot: string, requested: string): string {
  return path.relative(canonicalExisting(repoRoot, "REPOSITORY_NOT_FOUND"), canonicalizeRepoPath(repoRoot, requested)).split(path.sep).join("/");
}

function canonicalTaskPath(taskId: string): string {
  safeTaskId(taskId);
  const registry = readTaskRegistryByTaskId(taskId);
  if (!registry) throw new IsolationError("TASK_NOT_REGISTERED", taskId);
  return canonicalTaskRegistryPath(registry.workspaceId, taskId);
}

export function taskRegistryPath(taskId: string): string {
  return canonicalTaskPath(taskId);
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

function readJson<T>(file: string, code: string): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    throw new IsolationError(code, file);
  }
}

function inspectRepo(rootInput: string): RepoIdentity {
  const root = canonicalExisting(rootInput, "WORKSPACE_NOT_FOUND");
  const gitRootResult = runGit(root, ["rev-parse", "--show-toplevel"]);
  if (!gitRootResult.ok || gitRootResult.stdout.trim() === "") throw new IsolationError("VERIFICATION_FAILED", "git root");
  const repoRoot = canonicalExisting(gitRootResult.stdout.trim(), "REPOSITORY_NOT_FOUND");
  const commonResult = runGit(root, ["rev-parse", "--git-common-dir"]);
  if (!commonResult.ok || commonResult.stdout.trim() === "") throw new IsolationError("VERIFICATION_FAILED", "git common dir");
  const commonDir = canonicalExisting(
    path.isAbsolute(commonResult.stdout.trim())
      ? commonResult.stdout.trim()
      : path.resolve(repoRoot, commonResult.stdout.trim()),
    "REPOSITORY_ID_UNAVAILABLE"
  );
  const headResult = runGit(root, ["rev-parse", "HEAD"]);
  const branchResult = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!headResult.ok || !branchResult.ok || headResult.stdout.trim() === "" || branchResult.stdout.trim() === "") throw new IsolationError("VERIFICATION_FAILED", "git identity");
  return {
    repoRoot,
    repoId: createHash("sha256").update(process.platform === "win32" ? commonDir.toLowerCase() : commonDir).digest("hex").slice(0, 16),
    head: headResult.stdout.trim(),
    branch: branchResult.stdout.trim(),
  };
}

function makeRegistry(input: TaskRegistrationInput, status: TaskStatus, identity: RepoIdentity): TaskRegistry {
  const workspace = new Workspace(input.workspaceRoot);
  const workspaceName = input.workspaceName ?? workspace.name;
  if (workspace.name !== workspaceName) throw new IsolationError("WORKSPACE_NAME_MISMATCH", workspaceName);
  if (input.repoRoot !== undefined && !samePath(input.repoRoot, identity.repoRoot)) {
    throw new IsolationError("REPO_ROOT_MISMATCH", input.repoRoot);
  }
  if (input.repoId !== undefined && input.repoId !== identity.repoId) {
    throw new IsolationError("REPO_ID_MISMATCH", input.repoId);
  }
  if (input.baselineHead !== identity.head) {
    throw new IsolationError("BASELINE_MISMATCH", `expected ${identity.head}, got ${input.baselineHead}`);
  }
  if (samePath(input.workspaceRoot, input.worktreeRoot)) {
    throw new IsolationError("WORKTREE_MUST_BE_DEDICATED", input.worktreeRoot);
  }
  if (!input.branch || !input.branch.startsWith("task/")) {
    throw new IsolationError("INVALID_TASK_BRANCH", input.branch);
  }
  if (!Array.isArray(input.allowedFiles) || input.allowedFiles.length === 0) {
    throw new IsolationError("INVALID_ALLOWED_FILES", input.taskId);
  }
  if (!Array.isArray(input.acceptanceCommands) || input.acceptanceCommands.length === 0) {
    throw new IsolationError("INVALID_ACCEPTANCE_COMMANDS", input.taskId);
  }
  if (!Number.isInteger(input.iteration ?? 0) || (input.iteration ?? 0) < 0) {
    throw new IsolationError("INVALID_TASK_ITERATION", input.taskId);
  }
  const now = new Date().toISOString();
  return {
    taskId: input.taskId,
    workspaceName,
    workspaceRoot: canonicalExisting(input.workspaceRoot, "WORKSPACE_NOT_FOUND"),
    workspaceId: workspace.id,
    repoRoot: identity.repoRoot,
    repoId: identity.repoId,
    baselineHead: input.baselineHead,
    worktreeRoot: assertConfiguredWorktree(input.worktreeRoot),
    branch: input.branch,
    allowedFiles: input.allowedFiles,
    acceptanceCommands: input.acceptanceCommands,
    stopConditions: input.stopConditions ?? [],
    iteration: input.iteration ?? 0,
    createdAt: now,
    updatedAt: now,
    status,
    lease: null,
    executionRecordPersisted: false,
  };
}

function persistNewRegistry(registry: TaskRegistry): TaskRegistry {
  assertRegistryAvailable(registry);
  return createTaskRegistry(registry);
}

function assertRegistryAvailable(registry: TaskRegistry): void {
  for (const candidate of readAllTaskRegistries()) {
    if (candidate.taskId === registry.taskId) throw new IsolationError("TASK_ALREADY_REGISTERED", registry.taskId);
    if (candidate.worktreeRoot && registry.worktreeRoot && samePath(candidate.worktreeRoot, registry.worktreeRoot)) throw new IsolationError("WORKTREE_ALREADY_REGISTERED", candidate.taskId);
    if (candidate.repoId === registry.repoId && candidate.branch === registry.branch) throw new IsolationError("BRANCH_ALREADY_REGISTERED", candidate.taskId);
  }
}

function updateRegistry(registry: TaskRegistry, status: TaskStatus, changes: Partial<TaskRegistry> = {}): TaskRegistry {
  return updateTaskRegistry(registry, { ...changes, status });
}

export function readTaskRegistry(taskId: string): TaskRegistry | null {
  safeTaskId(taskId);
  try {
    return readTaskRegistryByTaskId(taskId);
  } catch (error) {
    throw error instanceof IsolationError ? error : new IsolationError("TASK_REGISTRY_INVALID", taskId);
  }
}

export function findTaskRegistryByWorktree(worktreeRoot: string): TaskRegistry | null {
  const matches = readAllTaskRegistries().filter((value) => value.worktreeRoot && samePath(value.worktreeRoot, worktreeRoot));
  if (matches.length > 1) throw new IsolationError("WORKTREE_NOT_UNIQUE", worktreeRoot);
  return matches[0] ?? null;
}

export function registerTask(input: TaskRegistrationInput): TaskRegistry {
  authorizeControlPlane("task_register");
  safeTaskId(input.taskId);
  const identity = inspectRepo(input.workspaceRoot);
  const registry = makeRegistry(input, "REGISTERED", identity);
  assertRegistryAvailable(registry);
  validateWorktree(registry);
  return persistNewRegistry(registry);
}

function configuredWorktreeRoot(): string {
  return path.resolve(process.env.C2C_WORKTREE_ROOT?.trim() || DEFAULT_TASK_WORKTREE_ROOT);
}

function physicalWithin(root: string, candidate: string): boolean {
  const normalize = (value: string): string => (process.platform === "win32" ? value.toLowerCase() : value);
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertConfiguredWorktree(worktreeRoot: string): string {
  const root = canonicalDeepPath(configuredWorktreeRoot());
  const target = canonicalDeepPath(worktreeRoot);
  if (!physicalWithin(root, target)) throw new IsolationError("PHYSICAL_PATH_ESCAPE", worktreeRoot);
  return target;
}

function validateWorktree(registry: TaskRegistry): void {
  if (!registry.worktreeRoot || !registry.branch || !registry.repoRoot || !registry.repoId) throw new IsolationError("TASK_WORKTREE_REQUIRED", registry.taskId);
  const physicalRoot = assertConfiguredWorktree(registry.worktreeRoot);
  if (!samePath(physicalRoot, registry.worktreeRoot)) throw new IsolationError("PHYSICAL_PATH_ESCAPE", registry.worktreeRoot);
  const worktree = inspectRepo(physicalRoot);
  if (!samePath(worktree.repoRoot, registry.worktreeRoot)) throw new IsolationError("GIT_ROOT_MISMATCH", registry.worktreeRoot);
  if (worktree.repoId !== registry.repoId) throw new IsolationError("REPO_ID_MISMATCH", registry.worktreeRoot);
  if (worktree.head !== registry.baselineHead) throw new IsolationError("BASELINE_MISMATCH", registry.worktreeRoot);
  if (worktree.branch !== registry.branch) throw new IsolationError("BRANCH_MISMATCH", registry.worktreeRoot);
}

type ControlPlaneGitOperation = {
  kind: "worktree_add";
  repoRoot: string;
  branch: string;
  worktreeRoot: string;
  baselineHead: string;
};

function runControlPlaneGit(operation: ControlPlaneGitOperation): void {
  const result = runGit(operation.repoRoot, ["worktree", "add", "-b", operation.branch, operation.worktreeRoot, operation.baselineHead]);
  if (!result.ok) throw new IsolationError("TASK_WORKTREE_CREATE_FAILED", result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`);
}

export function createTaskWorktree(
  input: Omit<TaskRegistrationInput, "worktreeRoot" | "branch"> & { worktreeRoot?: string; branch?: string }
): TaskRegistry {
  authorizeMutation("WORKTREE_CONTROL_PLANE", "task_create");
  safeTaskId(input.taskId);
  const identity = inspectRepo(input.workspaceRoot);
  const worktreeRoot = assertConfiguredWorktree(input.worktreeRoot ?? path.join(configuredWorktreeRoot(), input.taskId));
  const branch = input.branch || `task/${input.taskId}`;
  if (fs.existsSync(worktreeRoot)) throw new IsolationError("WORKTREE_ALREADY_EXISTS", worktreeRoot);
  ensureDir(path.dirname(worktreeRoot));
  const pending = makeRegistry({ ...input, worktreeRoot, branch }, "CREATING", identity);
  persistNewRegistry(pending);
  try {
    runControlPlaneGit({ kind: "worktree_add", repoRoot: identity.repoRoot, branch, worktreeRoot, baselineHead: input.baselineHead });
    assertConfiguredWorktree(worktreeRoot);
    validateWorktree(pending);
    return updateRegistry(pending, "REGISTERED");
  } catch (error) {
    updateRegistry(pending, "FAILED");
    throw error;
  }
}

export function isMainWorktree(rootInput: string, mainRoot = DEFAULT_MAIN_WORKTREE_ROOT): boolean {
  const root = path.resolve(rootInput);
  const configured = path.resolve(mainRoot);
  try {
    return samePath(fs.realpathSync.native(root), fs.realpathSync.native(configured));
  } catch {
    return samePath(root, configured);
  }
}

export function assertMainWorktreeReadOnly(root: string, operation: MutationOperation): void {
  if (isMainWorktree(root)) {
    throw new IsolationError("MAIN_WORKTREE_READ_ONLY", `${operation} is not allowed for ${path.resolve(root)}`);
  }
}

export function assertAuditMode(root: string, operation: AuditOperation | MutationOperation): void {
  const auditOperations = new Set<AuditOperation>([
    "workspace_info",
    "git_status",
    "git_diff",
    "read",
    "search",
    "test_status",
    "execution_summary",
  ]);
  if (isMainWorktree(root) && !auditOperations.has(operation as AuditOperation)) {
    throw new IsolationError("MAIN_WORKTREE_READ_ONLY", `${operation} is not an audit operation`);
  }
}

function validationError(code: string, validation: TaskExecutionValidation): IsolationError {
  const gates = Object.entries(validation)
    .filter(([key, value]) => key !== "registry" && typeof value === "boolean")
    .map(([key, value]) => `${key}=${value ? "YES" : "NO"}`)
    .join(" ");
  return new IsolationError(code, gates);
}

export function validateTaskExecution(input: {
  taskId: string;
  workspaceName: string;
  workspaceRoot: string;
  worktreeRoot: string;
}): TaskExecutionValidation {
  let registry: TaskRegistry | undefined;
  let verificationFailed = false;
  try {
    registry = readTaskRegistry(input.taskId) ?? undefined;
  } catch {
    verificationFailed = true;
  }
  const base: TaskExecutionValidation = {
    taskRegistered: Boolean(registry),
    statusAllowed: registry ? registry.status === "REGISTERED" || registry.status === "ACTIVE" : false,
    workspaceNameMatch: false,
    workspaceRootMatch: false,
    repoRootMatch: false,
    repoIdentityMatch: false,
    gitRootMatch: false,
    worktreeMatch: false,
    branchMatch: false,
    baselineMatch: false,
    taskLeaseHeld: false,
    worktreeLeaseHeld: false,
    verificationFailed,
    registry,
  };
  if (!registry) return base;
  try {
    const workspace = new Workspace(input.workspaceRoot);
    const source = inspectRepo(input.workspaceRoot);
    base.workspaceNameMatch = workspace.name === registry.workspaceName;
    base.workspaceRootMatch = samePath(workspace.root, registry.workspaceRoot);
    base.repoRootMatch = registry.repoRoot !== null && samePath(source.repoRoot, registry.repoRoot);
    base.repoIdentityMatch = registry.repoId !== null && source.repoId === registry.repoId;
    base.worktreeMatch = registry.worktreeRoot !== null && samePath(input.worktreeRoot, registry.worktreeRoot);
    if (!base.worktreeMatch || !registry.worktreeRoot) return base;
    const actual = inspectRepo(input.worktreeRoot);
    base.repoIdentityMatch = base.repoIdentityMatch && registry.repoId === actual.repoId;
    base.gitRootMatch = samePath(actual.repoRoot, registry.worktreeRoot);
    base.branchMatch = registry.branch !== null && actual.branch === registry.branch;
    base.baselineMatch = actual.head === registry.baselineHead;
    base.taskLeaseHeld = leaseFilesHeld(registry);
    base.worktreeLeaseHeld = base.taskLeaseHeld;
  } catch {
    base.verificationFailed = true;
  }
  return base;
}

export function assertTaskRegistrationReady(input: {
  taskId: string;
  workspaceName: string;
  workspaceRoot: string;
  worktreeRoot: string;
}): TaskRegistry {
  const validation = validateTaskExecution(input);
  if (!validation.taskRegistered) throw validationError("TASK_NOT_REGISTERED", validation);
  if (validation.verificationFailed) throw validationError("VERIFICATION_FAILED", validation);
  if (!validation.statusAllowed) throw validationError("TASK_STATUS_NOT_ALLOWED", validation);
  if (!validation.workspaceNameMatch || !validation.workspaceRootMatch || !validation.repoRootMatch || !validation.repoIdentityMatch) {
    throw validationError("WORKSPACE_IDENTITY_MISMATCH", validation);
  }
  if (!validation.worktreeMatch || !validation.gitRootMatch) throw validationError("WORKTREE_MISMATCH", validation);
  if (!validation.branchMatch) throw validationError("BRANCH_MISMATCH", validation);
  if (!validation.baselineMatch) throw validationError("BASELINE_MISMATCH", validation);
  return validation.registry!;
}

export function assertTaskExecutionReady(input: {
  taskId: string;
  workspaceName: string;
  workspaceRoot: string;
  worktreeRoot: string;
}): TaskRegistry {
  const validation = validateTaskExecution(input);
  const registry = assertTaskRegistrationReady(input);
  if (!validation.taskLeaseHeld || !validation.worktreeLeaseHeld) throw validationError("TASK_LEASE_REQUIRED", validation);
  return registry;
}

export function withAuthorizedTaskExecution<T>(
  input: { taskId: string; workspaceName: string; workspaceRoot: string; worktreeRoot: string },
  callback: (registry: TaskRegistry, lease: TaskLease) => T,
  ownerId = `${process.pid}:task-execution`
): T {
  const registered = assertTaskRegistrationReady(input);
  const lease = acquireTaskLease(registered.taskId, ownerId);
  try {
    const authorized = assertTaskExecutionReady(input);
    return callback(authorized, lease);
  } finally {
    releaseTaskLease(lease);
  }
}

function normalizedAllowedFile(repoRoot: string, file: string): string | null {
  const trimmed = file.trim();
  const suffix = trimmed.endsWith("/**") ? "/**" : trimmed.endsWith("/*") ? "/*" : "";
  const base = suffix ? trimmed.slice(0, -suffix.length) : trimmed;
  try {
    return canonicalRelative(repoRoot, base || ".").toLowerCase() + suffix;
  } catch {
    return null;
  }
}

function allowedFile(file: string, allowedFiles: string[], repoRoot: string): boolean {
  let candidate: string;
  try {
    candidate = canonicalRelative(repoRoot, file).toLowerCase();
  } catch {
    return false;
  }
  return allowedFiles.some((raw) => {
    const allowed = normalizedAllowedFile(repoRoot, raw);
    if (!allowed) return false;
    if (allowed === candidate) return true;
    if (allowed.endsWith("/**")) return candidate.startsWith(allowed.slice(0, -2));
    return allowed.endsWith("/*") && candidate.startsWith(allowed.slice(0, -1)) && !candidate.slice(allowed.length - 1).includes("/");
  });
}

function nulPaths(output: string, operation: string): string[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) throw new IsolationError("SCOPE_VERIFICATION_FAILED", `${operation}: truncated NUL record`);
  return output.split("\0").slice(0, -1).map((value) => {
    if (!value) throw new IsolationError("SCOPE_VERIFICATION_FAILED", `${operation}: missing path`);
    return value;
  });
}

export function inspectTaskScope(taskId: string, worktreeRoot: string): TaskScopeReport {
  const registry = readTaskRegistry(taskId);
  if (!registry) throw new IsolationError("TASK_NOT_REGISTERED", taskId);
  if (!registry.worktreeRoot || !samePath(worktreeRoot, registry.worktreeRoot)) throw new IsolationError("WORKTREE_MISMATCH", worktreeRoot);
  const fail = (error: unknown): TaskScopeReport => ({
    taskId,
    status: "SCOPE_VERIFICATION_FAILED",
    allowedFiles: registry.allowedFiles,
    trackedModified: [],
    outsideTracked: [],
    untracked: [],
    ignoredFiles: [],
    finalDiff: "",
    finalStatus: error instanceof Error ? error.message : String(error),
  });
  try {
    const required = (result: ReturnType<typeof runGit>, operation: string): string => {
      if (!result.ok) throw new IsolationError("SCOPE_VERIFICATION_FAILED", `${operation}: ${result.stderr.trim() || `exit ${result.code}`}`);
      return result.stdout;
    };
    const cached = nulPaths(required(runGit(worktreeRoot, ["diff", "--cached", "--name-only", "-z", "--", "."]), "git diff cached"), "git diff cached");
    const unstaged = nulPaths(required(runGit(worktreeRoot, ["diff", "--name-only", "-z", "--", "."]), "git diff unstaged"), "git diff unstaged");
    const statusOutput = required(runGit(worktreeRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--", "."]), "git status");
    const parsed = parsePorcelainStatus(statusOutput);
    const tracked = new Set([...cached, ...unstaged, ...parsed.tracked.map((entry) => entry.path)]);
    const trackedModified = [...tracked];
    const outsideTracked = trackedModified.filter((file) => !allowedFile(file, registry.allowedFiles, registry.worktreeRoot!));
    const finalDiff = required(runGit(worktreeRoot, ["diff", "HEAD", "--", "."]), "git diff HEAD");
    const reportStatus = outsideTracked.length > 0 ? "SCOPE_VIOLATION" : parsed.untracked.length > 0 ? "UNTRACKED_FILES_PRESENT" : "PASS";
    return { taskId, status: reportStatus, allowedFiles: registry.allowedFiles, trackedModified, outsideTracked, untracked: parsed.untracked, ignoredFiles: parsed.ignored, finalDiff, finalStatus: statusOutput.replace(/\0/g, "\n") };
  } catch (error) {
    return fail(error);
  }
}

export function assertTaskScope(taskId: string, worktreeRoot: string): TaskScopeReport {
  const report = inspectTaskScope(taskId, worktreeRoot);
  if (report.status !== "PASS") throw new IsolationError(report.status, report.outsideTracked.concat(report.untracked).join(", ") || report.finalStatus);
  return report;
}

function leasePath(kind: "task" | "worktree", value: string): string {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  const key = createHash("sha256").update(process.platform === "win32" ? normalized.toLowerCase() : normalized).digest("hex").slice(0, 24);
  return path.join(getStateDir(), "tasks", "leases", `${kind}-${key}.json`);
}

export function taskLeasePath(taskId: string): string {
  return leasePath("task", taskId);
}

export function worktreeLeasePath(worktreeRoot: string): string {
  return leasePath("worktree", worktreeRoot);
}

function readLease(file: string): TaskLease {
  try {
    const lease = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TaskLease>;
    if (![lease.leaseId, lease.taskLeaseId, lease.worktreeLeaseId, lease.taskId, lease.worktreeRoot, lease.ownerId, lease.acquiredAt, lease.expiresAt].every((value) => typeof value === "string" && value.length > 0)) throw new Error("invalid lease");
    if (!Number.isFinite(Date.parse(lease.acquiredAt!)) || !Number.isFinite(Date.parse(lease.expiresAt!))) throw new Error("invalid lease dates");
    return lease as TaskLease;
  } catch {
    throw new IsolationError("TASK_LEASE_CORRUPT", file);
  }
}

function priorLease(taskId: string, worktreeRoot: string): TaskLease | null {
  const taskFile = taskLeasePath(taskId);
  const worktreeFile = worktreeLeasePath(worktreeRoot);
  const taskExists = fs.existsSync(taskFile);
  const worktreeExists = fs.existsSync(worktreeFile);
  if (!taskExists && !worktreeExists) return null;
  if (taskExists !== worktreeExists) throw new IsolationError("TASK_LEASE_CORRUPT", `${taskFile};${worktreeFile}`);
  const taskLease = readLease(taskFile);
  const worktreeLease = readLease(worktreeFile);
  if (JSON.stringify(taskLease) !== JSON.stringify(worktreeLease)) throw new IsolationError("TASK_LEASE_CORRUPT", taskId);
  return taskLease;
}

function persistLease(file: string, lease: TaskLease): void {
  ensureDir(path.dirname(file));
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch {
    throw new IsolationError("TASK_LEASE_CONFLICT", file);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(lease, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function leaseMatches(registry: TaskRegistry, lease: TaskLease): boolean {
  return Boolean(registry.lease && registry.lease.taskLeaseId === lease.taskLeaseId && registry.lease.worktreeLeaseId === lease.worktreeLeaseId && registry.lease.taskId === lease.taskId && registry.lease.worktreeRoot && samePath(registry.lease.worktreeRoot, lease.worktreeRoot) && registry.lease.ownerId === lease.ownerId && registry.lease.expiresAt === lease.expiresAt);
}

function leaseFilesHeld(registry: TaskRegistry): boolean {
  if (!registry.worktreeRoot || !registry.lease) return false;
  try {
    const taskLease = readLease(taskLeasePath(registry.taskId));
    const worktreeLease = readLease(worktreeLeasePath(registry.worktreeRoot));
    return JSON.stringify(taskLease) === JSON.stringify(worktreeLease) && leaseMatches(registry, taskLease) && Date.parse(taskLease.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

export function acquireTaskLease(taskId: string, ownerId = `${process.pid}`, options: LeaseOptions = {}): TaskLease {
  let registry = readTaskRegistry(taskId);
  if (!registry) throw new IsolationError("TASK_NOT_REGISTERED", taskId);
  if (!registry.worktreeRoot) throw new IsolationError("TASK_WORKTREE_REQUIRED", taskId);
  const worktreeRoot = registry.worktreeRoot;
  const now = options.now ?? new Date();
  let existing = priorLease(taskId, worktreeRoot);
  if (registry.status !== "REGISTERED") {
    if (registry.status !== "ACTIVE" || !existing) throw new IsolationError("TASK_NOT_LEASEABLE", `${taskId} is ${registry.status}`);
    if (Date.parse(existing.expiresAt) > now.getTime()) throw new IsolationError("TASK_LEASE_CONFLICT", taskId);
    if (!options.recoverStale) throw new IsolationError("STALE_LEASE_RECOVERY_REQUIRED", taskId);
    fs.rmSync(taskLeasePath(taskId), { force: true });
    fs.rmSync(worktreeLeasePath(worktreeRoot), { force: true });
    registry = updateRegistry(registry, "REGISTERED", { lease: null });
    existing = null;
  }
  if (existing) {
    if (Date.parse(existing.expiresAt) > now.getTime()) throw new IsolationError("TASK_LEASE_CONFLICT", taskId);
    if (!options.recoverStale) throw new IsolationError("STALE_LEASE_RECOVERY_REQUIRED", taskId);
    fs.rmSync(taskLeasePath(taskId), { force: true });
    fs.rmSync(worktreeLeasePath(worktreeRoot), { force: true });
  }
  const acquiredAt = now.toISOString();
  const lease: TaskLease = {
    leaseId: randomUUID(),
    taskLeaseId: randomUUID(),
    worktreeLeaseId: randomUUID(),
    taskId,
    worktreeRoot,
    ownerId,
    acquiredAt,
    expiresAt: new Date(now.getTime() + Math.max(1, options.ttlMs ?? 15 * 60 * 1000)).toISOString(),
  };
  persistLease(taskLeasePath(taskId), lease);
  try {
    persistLease(worktreeLeasePath(worktreeRoot), lease);
    const persisted = updateRegistry(registry, "ACTIVE", {
      lease: {
        taskLeaseId: lease.taskLeaseId,
        worktreeLeaseId: lease.worktreeLeaseId,
        taskId: lease.taskId,
        worktreeRoot: lease.worktreeRoot,
        ownerId: lease.ownerId,
        acquiredAt: lease.acquiredAt,
        expiresAt: lease.expiresAt,
      },
    });
    if (!leaseMatches(persisted, lease)) throw new IsolationError("TASK_LEASE_PERSISTENCE_FAILED", taskId);
    return lease;
  } catch (error) {
    fs.rmSync(taskLeasePath(taskId), { force: true });
    fs.rmSync(worktreeLeasePath(worktreeRoot), { force: true });
    throw error;
  }
}

export function releaseTaskLease(lease: TaskLease): void {
  const registry = readTaskRegistry(lease.taskId);
  if (!registry) throw new IsolationError("TASK_NOT_REGISTERED", lease.taskId);
  const taskFile = taskLeasePath(lease.taskId);
  const worktreeFile = worktreeLeasePath(lease.worktreeRoot);
  if (!fs.existsSync(taskFile) || !fs.existsSync(worktreeFile)) throw new IsolationError("TASK_LEASE_NOT_FOUND", lease.taskId);
  const taskLease = readLease(taskFile);
  const worktreeLease = readLease(worktreeFile);
  if (!leaseMatches(registry, taskLease) || JSON.stringify(taskLease) !== JSON.stringify(worktreeLease) || taskLease.leaseId !== lease.leaseId) throw new IsolationError("TASK_LEASE_OWNER_MISMATCH", lease.taskId);
  fs.rmSync(taskFile, { force: true });
  fs.rmSync(worktreeFile, { force: true });
  updateRegistry(registry, registry.status === "ACTIVE" ? "REGISTERED" : registry.status, { lease: null });
}

export function markTaskBlocked(taskId: string, reason: string): void {
  const registry = readTaskRegistry(taskId);
  if (!registry) throw new IsolationError("TASK_NOT_REGISTERED", taskId);
  if (!leaseFilesHeld(registry)) throw new IsolationError("TASK_LEASE_REQUIRED", taskId);
  updateRegistry(registry, "BLOCKED", { executionRecordPersisted: false });
  const file = `${canonicalTaskPath(taskId)}.summary.json`;
  writeDurableJson(file, { taskId, status: "BLOCKED", reason, recordedAt: new Date().toISOString() });
}

function summaryPath(taskId: string): string {
  return `${canonicalTaskPath(taskId)}.summary.json`;
}

export function writeExecutionSummary(summary: TaskExecutionSummary): TaskExecutionSummary {
  authorizeMutation("TASK_WORKTREE_MUTATION", "execution_summary");
  safeTaskId(summary.taskId);
  const registry = readTaskRegistry(summary.taskId);
  if (!registry) throw new IsolationError("TASK_NOT_REGISTERED", summary.taskId);
  if (!registry.worktreeRoot || !samePath(summary.worktreeRoot, registry.worktreeRoot)) throw new IsolationError("WORKTREE_MISMATCH", summary.worktreeRoot);
  if (!leaseFilesHeld(registry)) throw new IsolationError("TASK_LEASE_REQUIRED", summary.taskId);
  if (registry.branch !== summary.branch || registry.baselineHead !== summary.baselineHead) throw new IsolationError("TASK_IDENTITY_MISMATCH", summary.taskId);
  writeDurableJson(summaryPath(summary.taskId), summary);
  const terminalStatus: TaskStatus = summary.status === "ok" || summary.status === "EXECUTED" ? "EXECUTED" : "BLOCKED";
  updateRegistry(registry, terminalStatus, { iteration: summary.iteration });
  return readExecutionSummary(summary.taskId)!;
}

export function readExecutionSummary(taskId: string): TaskExecutionSummary | null {
  const file = summaryPath(taskId);
  if (!fs.existsSync(file)) return null;
  return readJson<TaskExecutionSummary>(file, "TASK_EXECUTION_SUMMARY_CORRUPT");
}
