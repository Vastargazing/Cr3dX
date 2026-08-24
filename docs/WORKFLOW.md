# Cr3dX contributor workflow and role isolation

This file is the portable owner of the process. It is committed with the
repository and is mandatory for every new workstation and chat. A local
instruction file, if present, memory, chat history and verbal agreements may
help only when they agree with the committed documents at the handed-off hash.
On a conflict, the committed documents take precedence and the other context is
stale by default. It may trigger a discrepancy report, but it cannot override
the documents.

## Sources of truth

At the start of a new session, read in this order:

1. `docs/WORKFLOW.md` for roles, access boundaries and phase order;
2. `docs/cr3dx-spec-v0.4.0-final.md` for the current target semantics;
3. `docs/STATUS.md` for completed work, current addresses, evidence and open
   items;
4. code and tests, only if the current chat role may access them.

The reading order is not a global precedence order. `docs/WORKFLOW.md` governs
process, roles and access boundaries. The specification governs target
behavior. The latest applicable `docs/STATUS.md` entry and the tracked
`deployments/*.json` ledgers record completed work, deployed addresses and live
observations. Code, tests or chain reads may reveal a mismatch, but they do not
silently change one of these records: stop, report the exact conflict and
reconcile it in the owning source. The README explains the project but does not
define target behavior.

## Roles and chats

### Coordinator

The coordinator is the person who owns routing between chats. Only the
coordinator:

- gives agents prompts and exact input commit hashes;
- decides when the specification is ready for handoff;
- transfers results between isolated chats;
- opens Phase B after both independent branches are complete;
- authorizes redeployment and external actions.

Agents do not transfer context to one another on their own and do not expand
their access by assumption.

### Read-only reviewer

The reviewer receives explicitly scoped inputs and checks claims against their
sources without editing the reviewed artifact. The response identifies exact
evidence, counterexamples, severity and proposed replacement wording. The
artifact author applies accepted changes.

Reviewer acceptance does not authorize a merge, deployment or any other
external action. Only the coordinator grants those permissions. A claim of
independent review requires a separate chat from the artifact author. The
reviewer does not expand its input scope by assumption and remains subject to
all blind boundaries that apply before Phase B.

### Specification chat

Its task is to define target semantics before the implementation changes. Its
allowed inputs are the current specification, the threat model, a discovered
counterexample and coordinator decisions.

A behavioral change produces a separate document-only commit marked
`implementation pending`. It contains no code, test, deployment artifact or new
live acceptance result.

### Blind model chat

Its task is to build an independent model and oracle from the target
specification.

The blind agent must not see:

- contract implementation or its diff;
- implementation tests or names of added regressions when they expose the
  chosen mechanism;
- implementation commits, deployment artifacts or results from running the new
  code;
- conclusions from the implementation chat about convenient ways to implement
  the rule.

The allowed input is a materialized document package of the target
specification, identified by the full hash of its document-only commit, plus a
separate coordinator prompt. `Document-only` describes the commit diff, not its
entire tree. The parents of an ordinary commit may already contain the
implementation. The blind chat therefore does not receive a full checkout of
the implementation repository. It receives only explicitly listed document
files. If the input commit diff changes code or tests, or the environment
exposes them to the blind chat, the agent stops and reports the isolation breach.
Merely promising not to inspect them is insufficient.

### Implementation chat

Its task is to align code and tests with the fixed target specification. It
receives the same document-only hash as the blind agent but does not receive the
model, oracle or conclusions of the blind chat before Phase B.

The implementation does not change the specification after the fact to describe
convenient code behavior. If it finds a contradiction or an uncovered case, work
stops and returns to the specification chat.

### Phase B

Phase B begins only after the blind model and implementation are independently
complete against the same specification hash. This is the first point at which
the two sides may be compared.

Classify every mismatch before fixing it:

- implementation error;
- model error;
- specification ambiguity or contradiction;
- environment or evidence error.

A green test must not automatically be treated as proof that one side is
correct. First record the exact rule, input and observed mismatch.

## Mandatory order for a behavioral change

```text
target specification, document-only commit
                 /                    \
        blind model                implementation
                 \                    /
                          Phase B
                             |
                  redeployment and live acceptance
```

1. Record the counterexample and target decision in the specification.
2. Publish a separate document-only commit marked `implementation pending`.
3. The coordinator gives the same specification hash to the blind and
   implementation chats.
4. Both branches work independently.
5. In Phase B, compare the results and close mismatches using the classification
   above.
6. Only then redeploy changed contracts and perform live acceptance.
7. Record addresses, transactions, observations and test counts in
   `docs/STATUS.md`.
8. Remove `implementation pending` in a separate document update if needed.

An editorial change that does not affect behavior may follow the implementation,
but it must be explicitly identified as editorial. It does not receive
`implementation pending` status.

## Validate the prompt before work

A prompt is coordinator input, not unconditional truth. Before making changes,
the agent checks that:

- the stated hash exists and matches the described role;
- the specification version and status match the task;
- the working tree has no unrelated unfinished changes in affected files;
- the requested order does not conflict with this document;
- addresses and acceptance results belong to the correct deployment artifact.

On a substantive mismatch, the agent stops, presents exact evidence and discusses
it with the coordinator. A conflicting prompt must not be followed mechanically.

## Commits and hash handoff

- A specification commit contains only target-behavior documentation.
- An implementation commit contains code and tests. Its hash is not given to the
  blind agent.
- Workflow, handoff and editorial corrections are not mixed with behavioral
  code.
- Check `git status`, staged files and the diff before every commit.
- Give the blind agent the full 40-character specification hash and materialized
  document files from it, not a checkout of the entire implementation
  repository.
- Nothing in `main` is rewritten after the fact to create the appearance of
  independence.

## Workspace isolation and concurrency

- Only one agent may write to a checkout at a time.
- Parallel write tasks use separate branches and worktrees. Concurrent edits to
  the same document, especially `docs/STATUS.md`, are prohibited and the
  coordinator serializes them.
- Read-only review may run in parallel when it does not mutate the checkout or
  expand the reviewer's allowed inputs.
- Any directory designated as a sealed blind input or frozen verification
  artifact is read-only, even when no other writer is active. Do not edit,
  regenerate, format, build or run commands that create caches inside it.
- Writable model workspaces, replay adapters and execution results live in
  separate derived workspaces and receive their own hashes.

## Workstation portability

Minimum local check before work:

```sh
git submodule status
node --version
npm ci
forge --version
forge build
forge test
npm run test:scripts
npm run typecheck
```

If Foundry was installed through the standard `foundryup` path but a new shell
cannot find `forge`, first run `export PATH="$HOME/.foundry/bin:$PATH"`. This is a
shell environment change, not another installation step.

Node.js 20 or newer and stable Foundry are required. Installation is documented
in the README. `node_modules`, Foundry build output and secrets remain local.
The specification, workflow, status and deployment artifacts are committed.

A local file excluded by `.gitignore` cannot own required project state. If work
cannot continue correctly on another machine without a fact, that fact must be
in one of the three documents listed at the start of this file.

## Public attribution

Internal role names and chat organization exist only to control the process. Do
not add AI attribution or internal chat history to the README, public reports,
commits or submission materials unless the coordinator explicitly requests it.
Public text describes decisions, evidence and limitations.

## Recorded v0.4.4 exception

In v0.4.4, code, tests and live acceptance appeared before the final document
revision and entered the same commit. The blind agent did not see the
implementation, and semantic decisions preceded the code, so decision
independence was preserved. Wording independence cannot be proved. This
limitation is recorded in `docs/STATUS.md` and is not repaired with a
retrospective specification-only commit.

This workflow is mandatory from v0.4.5 onward.
