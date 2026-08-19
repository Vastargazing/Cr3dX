# Specification ambiguities

Owned by the independent invariant-test agent. **The main developer does not fill
this in.**

## What this file is for

The agent writing invariant tests works from `docs/cr3dx-spec-v0.4.0-final.md`
without reading the implementation. That separation only produces useful tests if
the agent never has to guess. Where the specification admits two readings, the
guess would be worthless twice over: a coin flip against the author's intent, and
a silent invitation to shape the model around whatever the code happens to do.

So: when a passage supports more than one reading, do not pick one. Record both
here and keep going. A recorded ambiguity is a finding about the specification. A
resolved-by-guessing ambiguity is a test that proves nothing.

## What belongs here

Only genuine ambiguity: the document supports two readings that lead to different
observable behaviour.

Not here:
- something the specification does not mention at all. That is an omission, and
  it goes in the same format with Interpretation B left as "undefined";
- something the specification states clearly that you disagree with. Follow it
  and say so separately;
- questions about the implementation. This file is about the document.

## Format

One block per ambiguity, appended in the order found.

```
### <short title>

Ambiguity:
    <the passage, quoted, and what is unclear about it>

Interpretation A:
    <first reading, and what the system would do under it>

Interpretation B:
    <second reading, and what the system would do under it>

Invariants affected:
    <INV-N, ...>

Minimal scenario exposing the difference:
    <the shortest sequence of actions whose outcome differs between A and B>
```

The minimal scenario is the load-bearing part. An ambiguity that no scenario can
distinguish is a wording preference, not an ambiguity.

## Resolution

Resolutions are made by the specification author, not here and not by the test
agent. When one lands, the specification changes with a note in its changelog,
and the block below is annotated with the version that resolved it.

---

*No entries yet. The specification was frozen at v0.4.2 before the blind review
began.*
