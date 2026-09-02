# C2C Agent Protocol

Control plane: Computer Use (tiny structured messages typed into the ChatGPT UI).
Data plane: MCP (ChatGPT pulls files, diffs, search results itself).

Never mix the two: control messages carry state, never content.

## States

```
INIT → PLAN → EXECUTING → EXECUTED → REVIEW → PLAN | DONE | BLOCKED | ERROR
```

| State | Sender | Meaning |
| --- | --- | --- |
| INIT | Codex | New task; asks ChatGPT to inspect + plan |
| PLAN | ChatGPT | Executable plan for the next iteration |
| EXECUTING | Codex | (optional) execution in progress |
| EXECUTED | Codex | Iteration finished; metadata only |
| REVIEW | ChatGPT | (implicit) ChatGPT is inspecting via MCP |
| DONE | ChatGPT | Success criteria met |
| BLOCKED | ChatGPT | Cannot proceed; contains reason |
| ERROR | either | Protocol/infrastructure failure |
| HANDOFF | Codex | Continuation brief sent to a replacement conversation |

## Message format

Every control message starts with `[C2C]` and key-value headers, then sections.
Keep messages < 1 KB. No diffs, no logs, no file bodies.

## Task identity and persistence gates

Before any coding-task modification, Codex must generate the task identity and
persist it outside the Git worktree. Trading_Tools MAIN is never an execution
root; create or register a dedicated worktree first:

```text
GENERATE TASK_ID
→ c2c task create -w <workspace> --task <id> --baseline <HEAD> \
  --allowed-files "..." --acceptance "..."
→ c2c task verify -w <workspace> --worktree <task-worktree> --task <id>
→ verify TASK_REGISTERED=YES WORKTREE_MATCH=YES BRANCH_MATCH=YES BASELINE_MATCH=YES
→ only then modify code
```

The isolated task registry stores task id, workspace name/root/id, repository
root/id, worktree root, task branch, pinned baseline, allowed files, acceptance
commands, iteration and status under the state directory. Every execution must
also acquire the task/worktree lease and pass the persisted identity checks.
`c2c task scope` compares tracked diff and status against `allowed-files`; an
outside tracked path is `SCOPE_VIOLATION`, and untracked paths are reported
explicitly. A failed persistence, identity, lease or scope check is fail-closed:
Codex must not modify MAIN or send `EXECUTED`.

### INIT (Codex → ChatGPT)

```
[C2C]
STATE: INIT
TASK_ID: c2c_f81a
ITERATION: 0

GOAL:
Implement dark mode.

INSTRUCTION:
Inspect the connected workspace through Codex with ChatGPT MCP.
Create an implementation plan for Codex.
```

### PLAN (ChatGPT → Codex)

```
[C2C]
STATE: PLAN
TASK_ID: c2c_f81a
ITERATION: 1

GOAL:
...

RATIONALE:
...

ACTIONS:
1. ...
2. ...
3. ...

FILES_LIKELY_INVOLVED:
...

TESTS:
...

SUCCESS_CRITERIA:
...
```

Plans must be finite, concrete, executable. Not 40-step epics.

### EXECUTED (Codex → ChatGPT)

```
[C2C]
STATE: EXECUTED
TASK_ID: c2c_f81a
ITERATION: 1

RESULT:
Execution finished.

CHANGED_FILES:
4

TESTS:
27 passed

Please independently inspect the workspace and current git diff through MCP.
```

Before sending EXECUTED, Codex records the iteration from the registered task
worktree and waits for lease, scope and persistence verification to pass:
`c2c record --task c2c_f81a --iteration 1 --changed-files ... --tests ... --exit-status ok`
For Git workspaces it requires the matching registered task worktree, acquires
both leases, checks identity and scope, persists the execution summary, then
updates the registry to `status=EXECUTED`. Non-Git workspaces use the explicitly
supported legacy JSONL record path. Only after persistence verification can
ChatGPT read the result via `execution_summary` / `test_status` and Codex send
`[C2C] EXECUTED`. If any check fails, the command exits non-zero and the
protocol message is `[C2C] EXECUTED=NOT_SENT` with `C2C_STATE=BLOCKED`.

### DONE / BLOCKED (ChatGPT → Codex)

```
[C2C]
STATE: DONE
TASK_ID: c2c_f81a
ITERATION: 3

SUMMARY:
...
```

```
[C2C]
STATE: BLOCKED
TASK_ID: c2c_f81a
ITERATION: 3

REASON:
...

NEEDS:
...
```

### HANDOFF (Codex → new ChatGPT conversation)

One workspace keeps one long-lived C2C conversation (`c2c session get/set`).
Codex switches to a new chat only when the user asks for it or the old chat has
grown long enough to lag. Right after the boot prompt, Codex sends a HANDOFF so
the new chat can continue seamlessly — a brief, never a data dump (the new chat
re-reads code via MCP):

```
[C2C]
STATE: HANDOFF
TASK_ID: c2c_f81a
ITERATION: 4

ORIGINAL_GOAL:
Implement dark mode with a persisted user preference.

PROGRESS:
- Iter 1-2: theme context + toggle implemented, reviewed OK.
- Iter 3: persistence added; review found the toggle flashes on load.

CURRENT_STATE:
EXECUTED (iteration 4 fix applied, not yet reviewed).

KNOWN_ISSUES:
Flash-on-load fix needs verification in src/theme/ThemeProvider.tsx.

NEXT_EXPECTED_STEP:
Independently review iteration 4 via git_diff and reply PLAN or DONE.
```

## Loop limits

`maxIterations` (default 12, configurable in `.c2c.json`). When reached, Codex
pauses and asks the user whether to continue.

## Boot Prompt

Send once at the start of every new C2C conversation:

```
You are the planning and review layer of a Codex coding session.

Codex owns execution.
You own high-level reasoning, planning and review.

You have access to the current local workspace through the
"Codex with ChatGPT" MCP connector.

Rules:

1. Do not ask Codex to paste files that are available through MCP.
2. Inspect only the files needed for the task.
3. Use MCP to inspect current code, git status and diff.
4. Produce concise executable plans.
5. Codex will execute your plan using its own harness.
6. After Codex reports EXECUTED, independently inspect the diff.
7. Do not assume an implementation succeeded just because Codex says so.
8. Continue until the implementation satisfies the success criteria.
9. Avoid unnecessary rewrites.
10. Return C2C structured control messages.
11. Be substantive. PLAN and review replies must carry enough signal for
    Codex to act on: rationale, per-file natural-language suggestions
    (which file, what to change and why), risks worth checking, and test
    advice. Never reply with a bare one-liner. Substance over length —
    but do not generate 40-step epics either.
12. If you receive a HANDOFF message, this conversation continues an
    existing task. Trust the handoff brief for history, re-read any code
    you need through MCP, and resume from NEXT_EXPECTED_STEP.
```
