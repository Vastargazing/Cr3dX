# Cr3dX contributor workflow and role isolation

This file is the portable owner of the process. It is committed with the
repository and is mandatory for every new workstation and work session. A local
instruction file, if present, memory, session history and verbal agreements may
help only when they agree with the committed documents at the handed-off hash.
On a conflict, the committed documents take precedence and the other context is
stale by default. It may trigger a discrepancy report, but it cannot override
the documents.

## Sources of truth

At the start of a new session, read in this order:

1. `docs/WORKFLOW.md` for roles, access boundaries and phase order;
2. `docs/CR3DX_SPEC_V0.4.8_EN.md` for the current target semantics;
3. `docs/STATUS_EN.md` for completed work, current addresses, evidence and open
   items;
4. code and tests, only if the assigned role may access them.

The reading order is not a global precedence order. `docs/WORKFLOW.md` governs
process, roles and access boundaries. The specification governs target
behavior. `docs/STATUS_EN.md` and the tracked `deployments/*.json` ledgers record
completed work, deployed addresses and live observations. The original-language
chronological journal is consulted only when exact historical provenance is
required. Code, tests or chain reads may reveal a mismatch, but they do not
silently change one of these records: stop, report the exact conflict and
reconcile it in the owning source. The README explains the project but does not
define target behavior.

The Russian `docs/cr3dx-spec-v0.4.0-final.md` remains the immutable source used
by the completed v0.4.8 Phase A/B verification chain. It is retained for exact
provenance, not as the public contributor entry point. A disagreement between
the English v0.4.8 rendering and that sealed source is a translation defect,
not permission to choose whichever wording is convenient.

## Roles and isolated workspaces

### Coordinator

The coordinator owns scope, handoffs and routing between isolated workspaces.
Only the coordinator:

- gives each task an exact scope and input commit hash;
- decides when the specification is ready for handoff;
- transfers results between isolated workspaces;
- opens Phase B after both independent branches are complete;
- authorizes redeployment and external actions.

Participants do not transfer context across boundaries on their own and do not
expand their access by assumption.

### Read-only reviewer

The reviewer receives explicitly scoped inputs and checks claims against their
sources without editing the reviewed artifact. The response identifies exact
evidence, counterexamples, severity and proposed replacement wording. The
artifact author applies accepted changes.

Reviewer acceptance does not authorize a merge, deployment or any other
external action. Only the coordinator grants those permissions. A claim of
independent review requires a separate workspace and context from the artifact
author. The
reviewer does not expand its input scope by assumption and remains subject to
all blind boundaries that apply before Phase B.

### Specification workspace

Its task is to define target semantics before the implementation changes. Its
allowed inputs are the current specification, the threat model, a discovered
counterexample and coordinator decisions.

A behavioral change produces a separate document-only commit marked
`implementation pending`. It contains no code, test, deployment artifact or new
live acceptance result.

### Blind model workspace

Its task is to build an independent model and oracle from the target
specification.

The blind workspace must not expose:

- contract implementation or its diff;
- implementation tests or names of added regressions when they expose the
  chosen mechanism;
- implementation commits, deployment artifacts or results from running the new
  code;
- conclusions from the implementation workspace about convenient ways to
  implement the rule.

The allowed input is a materialized document package of the target
specification, identified by the full hash of its document-only commit, plus a
separate task brief. `Document-only` describes the commit diff, not its
entire tree. The parents of an ordinary commit may already contain the
implementation. The blind workspace therefore does not receive a full checkout
of the implementation repository. It receives only explicitly listed document
files. If the input commit diff changes code or tests, or the environment
exposes them to the blind workspace, work stops and the isolation breach is
reported.
Merely promising not to inspect them is insufficient.

### Implementation workspace

Its task is to align code and tests with the fixed target specification. It
receives the same document-only hash as the blind workspace but does not receive
the model, oracle or conclusions of that workspace before Phase B.

The implementation does not change the specification after the fact to describe
convenient code behavior. If it finds a contradiction or an uncovered case, work
stops and returns to the specification workspace.

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
3. The coordinator gives the same specification hash to the blind-model and
   implementation workspaces.
4. Both branches work independently.
5. In Phase B, compare the results and close mismatches using the classification
   above.
6. Only then redeploy changed contracts and perform live acceptance.
7. Record addresses, transactions, observations and test counts in the current
   status and its source journal.
8. Remove `implementation pending` in a separate document update if needed.

An editorial change that does not affect behavior may follow the implementation,
but it must be explicitly identified as editorial. It does not receive
`implementation pending` status.

## Validate the task input before work

A task brief is coordinator input, not unconditional truth. Before making
changes, the responsible participant checks that:

- the stated hash exists and matches the described role;
- the specification version and status match the task;
- the working tree has no unrelated unfinished changes in affected files;
- the requested order does not conflict with this document;
- addresses and acceptance results belong to the correct deployment artifact.

On a substantive mismatch, work stops and the exact evidence is presented to the
coordinator. Conflicting instructions must not be followed mechanically.

## Commits and hash handoff

- A specification commit contains only target-behavior documentation.
- An implementation commit contains code and tests. Its hash is not given to the
  blind-model workspace.
- Workflow, handoff and editorial corrections are not mixed with behavioral
  code.
- Check `git status`, staged files and the diff before every commit.
- Give the blind-model workspace the full 40-character specification hash and
  materialized document files from it, not a checkout of the entire
  implementation repository.
- Nothing in `main` is rewritten after the fact to create the appearance of
  independence.

## Workspace isolation and concurrency

- Only one writer may modify a checkout at a time.
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

## Public communication

Internal role names and workspace organization exist only to control the
process. Public material describes the engineering method, decisions, evidence
and limitations. Internal conversations and tool-specific attribution do not
belong in project claims unless an applicable rule requires them.

## Recorded v0.4.4 exception

In v0.4.4, code, tests and live acceptance appeared before the final document
revision and entered the same commit. The blind workspace did not expose the
implementation, and semantic decisions preceded the code, so decision
independence was preserved. Wording independence cannot be proved. This
limitation is recorded in the source journal and is not repaired with a
retrospective specification-only commit.

This workflow is mandatory from v0.4.5 onward.
