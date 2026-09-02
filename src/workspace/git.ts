import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
}

export class GitVerificationError extends Error {
  constructor(public readonly operation: string, result: GitCommandResult) {
    super(`GIT_VERIFICATION_FAILED: ${operation}: ${result.error ?? (result.stderr.trim() || (result.signal ? `signal ${result.signal}` : `exit ${result.code}`))}`);
    this.name = "GitVerificationError";
  }
}

function isNotRepository(result: GitCommandResult): boolean {
  return /not a git repository|outside (?:a )?repository/i.test(result.stderr);
}

export function runGit(root: string, args: string[]): GitCommandResult {
  try {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 });
    return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status, signal: result.signal, error: result.error?.message };
  } catch (error) {
    return { ok: false, stdout: "", stderr: "", code: null, signal: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface GitInfo {
  isRepo: boolean;
  branch: string | null;
  commit: string | null;
  dirty: boolean;
}

function strictGitOutput(result: GitCommandResult, operation: string): string {
  if (!result.ok) throw new GitVerificationError(operation, result);
  return result.stdout;
}

function canonicalDirectory(input: string, operation: string): string {
  try {
    const resolved = fs.realpathSync.native(path.resolve(input));
    if (!fs.statSync(resolved).isDirectory()) throw new Error("not a directory");
    return resolved;
  } catch {
    throw new GitVerificationError(operation, { ok: false, stdout: "", stderr: `invalid directory: ${input}`, code: null, signal: null });
  }
}

function ownRepositoryRoot(root: string): string | null {
  const workspaceRoot = canonicalDirectory(root, "workspace root");
  const result = runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
  if (!result.ok && isNotRepository(result)) return null;
  if (!result.ok) throw new GitVerificationError("git repository identity", result);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || lines[0].includes("\0")) throw new GitVerificationError("git repository identity", result);
  const gitRoot = canonicalDirectory(lines[0], "git repository root");
  return gitRoot === workspaceRoot ? gitRoot : null;
}

function strictSingleLine(result: GitCommandResult, operation: string): string {
  if (!result.ok) throw new GitVerificationError(operation, result);
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || lines[0].includes("\0") || lines[0].trim() === "") throw new GitVerificationError(operation, result);
  return lines[0].trim();
}

function readUpstream(root: string): string | null {
  const result = runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (result.ok) return strictSingleLine(result, "git upstream");
  if (/no upstream configured/i.test(result.stderr)) return null;
  throw new GitVerificationError("git upstream", result);
}

export interface ParsedPorcelainStatus {
  tracked: { path: string; change: string }[];
  untracked: string[];
  ignored: string[];
  conflicted: string[];
}

const PORCELAIN_STATUS_CHARS = new Set([" ", ".", "M", "A", "D", "R", "C", "U", "?", "!"]);

/** Parse Git v1 NUL-framed status without accepting partial or unknown records. */
export function parsePorcelainStatus(output: string): ParsedPorcelainStatus {
  if (output === "") return { tracked: [], untracked: [], ignored: [], conflicted: [] };
  if (!output.endsWith("\0")) throw new Error("GIT_STATUS_PARSE_FAILED: truncated NUL record");
  const records = output.split("\0").slice(0, -1);
  const parsed: ParsedPorcelainStatus = { tracked: [], untracked: [], ignored: [], conflicted: [] };
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.length < 4 || record[2] !== " ") throw new Error("GIT_STATUS_PARSE_FAILED: malformed status record");
    const code = record.slice(0, 2);
    if (!PORCELAIN_STATUS_CHARS.has(code[0]) || !PORCELAIN_STATUS_CHARS.has(code[1])) throw new Error(`GIT_STATUS_PARSE_FAILED: unknown status code ${code}`);
    if ((code.includes("?") && code !== "??") || (code.includes("!") && code !== "!!")) {
      throw new Error(`GIT_STATUS_PARSE_FAILED: invalid untracked/ignored status code ${code}`);
    }
    const filePath = record.slice(3);
    if (filePath === "") throw new Error("GIT_STATUS_PARSE_FAILED: missing path");
    if (code === "??") {
      parsed.untracked.push(filePath);
      continue;
    }
    if (code === "!!") {
      parsed.ignored.push(filePath);
      continue;
    }
    if (code.includes("R") || code.includes("C")) {
      const original = records[++index];
      if (!original) throw new Error("GIT_STATUS_PARSE_FAILED: rename/copy record missing path");
      parsed.tracked.push({ path: filePath, change: code }, { path: original, change: code });
    } else {
      parsed.tracked.push({ path: filePath, change: code });
    }
    if (code.includes("U")) parsed.conflicted.push(filePath);
  }
  return parsed;
}

export function gitInfo(root: string): GitInfo {
  const repo = ownRepositoryRoot(root);
  if (!repo) return { isRepo: false, branch: null, commit: null, dirty: false };
  const branch = strictSingleLine(runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "git branch");
  const commit = strictSingleLine(runGit(repo, ["rev-parse", "--short", "HEAD"]), "git commit");
  const status = parsePorcelainStatus(
    strictGitOutput(runGit(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--", "."]), "git status")
  );
  return { isRepo: true, branch, commit, dirty: status.tracked.length > 0 || status.untracked.length > 0 };
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: { path: string; change: string }[];
  unstaged: { path: string; change: string }[];
  untracked: string[];
  ignored: string[];
  conflicted: string[];
}

export function gitStatus(root: string): GitStatusResult {
  const empty: GitStatusResult = {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    ignored: [],
    conflicted: [],
  };
  const repo = ownRepositoryRoot(root);
  if (!repo) return empty;
  const parsed = parsePorcelainStatus(strictGitOutput(runGit(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--", "."]), "git status"));
  const out: GitStatusResult = {
    ...empty,
    isRepo: true,
    branch: strictSingleLine(runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), "git branch"),
    upstream: readUpstream(repo),
    staged: parsed.tracked.filter((entry) => entry.change[0] !== " ").map((entry) => ({ path: entry.path, change: entry.change[0] })),
    unstaged: parsed.tracked.filter((entry) => entry.change[1] !== " ").map((entry) => ({ path: entry.path, change: entry.change[1] })),
    untracked: parsed.untracked,
    ignored: parsed.ignored,
    conflicted: parsed.conflicted,
  };
  return out;
}

export type DiffMode = "unstaged" | "staged" | "head";

export interface GitDiffOptions {
  mode?: DiffMode;
  path?: string;
  offset?: number;
  maxBytes?: number;
}

export interface GitDiffResult {
  isRepo: boolean;
  mode: DiffMode;
  totalBytes: number;
  offset: number;
  returnedBytes: number;
  hasMore: boolean;
  nextOffset: number | null;
  diff: string;
}

const SENSITIVE_DIFF_EXCLUDES = [
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)**/*.pem",
  ":(exclude,glob)**/*.key",
  ":(exclude,glob)**/id_rsa*",
  ":(exclude,glob)**/id_ed25519*",
];

export function gitDiff(root: string, opts: GitDiffOptions = {}, relPath?: string): GitDiffResult {
  const mode = opts.mode ?? "unstaged";
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const maxBytes = Math.min(256 * 1024, Math.max(1024, Math.floor(opts.maxBytes ?? 64 * 1024)));

  const base: string[] = ["diff", "--no-color"];
  if (mode === "staged") base.push("--cached");
  if (mode === "head") base.push("HEAD");
  base.push("--");
  if (relPath) {
    base.push(relPath);
  } else {
    base.push(".", ...SENSITIVE_DIFF_EXCLUDES);
  }

  const repo = ownRepositoryRoot(root);
  if (!repo) {
    return {
      isRepo: false,
      mode,
      totalBytes: 0,
      offset: 0,
      returnedBytes: 0,
      hasMore: false,
      nextOffset: null,
      diff: "",
    };
  }
  const result = runGit(repo, base);
  if (!result.ok) throw new GitVerificationError("git diff", result);
  const full = Buffer.from(result.stdout, "utf8");
  const slice = full.subarray(offset, offset + maxBytes);
  let text = slice.toString("utf8");
  let sliceLen = slice.length;
  // Avoid cutting mid-line when more content follows.
  if (offset + sliceLen < full.length) {
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline > 0) {
      text = text.slice(0, lastNewline + 1);
      sliceLen = Buffer.byteLength(text, "utf8");
    }
  }
  const hasMore = offset + sliceLen < full.length;
  return {
    isRepo: true,
    mode,
    totalBytes: full.length,
    offset,
    returnedBytes: sliceLen,
    hasMore,
    nextOffset: hasMore ? offset + sliceLen : null,
    diff: text,
  };
}
