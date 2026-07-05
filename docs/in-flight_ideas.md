# jonobones — in-flight ideas

A scratchpad for directions under consideration but not yet committed. Each
entry is a candidate to research, evaluate against the northstar, and either
promote to a plan or drop. Nothing here is a commitment. When an entry grows
large enough to warrant its own structured exploration, split it into a sibling
`<topic>_ideas.md` and leave a one-line pointer here.

---

## Optimistic concurrency for contended writes (HTTP `If-Match` / `ETag`)

Status: candidate. Raised 2026-07-05 from a concurrency review of the write
path, verified against `@joplin/lib` 3.6.3.

### The problem

Two clients that write the same field of the same item concurrently resolve as
silent last-writer-wins: the later write overwrites the earlier one, both
return `200`, and no conflict is recorded. This is a genuine exposure for the
"multiple agents, one knowledge base" use case the northstar's first intent
invites.

It is not an integrity bug and not fixable in the engine. `@joplin/lib`
serializes writes correctly: `BaseModel.save` holds a per-item mutex
(`saveMutexes_`, keyed by model id) around the row write, and
`Database.transactionExecBatch` guards every multi-statement batch with a
second mutex around `BEGIN`/`COMMIT`. So there is never a torn write or a
bled transaction. What the engine does not provide is *detection*: the
read-modify-write is not atomic (`Note.save` loads the prior note before
acquiring the mutex; jonobones' `updateItem` loads earlier still), and the
`UPDATE` carries no version precondition (`updated_time` is set to now with no
compare-and-swap). Joplin was built for a single-writer desktop app, where the
app is the only writer; conflict copies (`is_conflict`) are a *synchronizer*
construct and never fire for two local in-process writers.

Two mitigations already hold and bound the scope. Updates are field-scoped, so
two agents editing *disjoint* fields both persist; the loss is confined to the
same-field case. And the overwritten value may be recoverable from note history
(`ItemChange.add` records a before-image the RevisionService can turn into a
revision), but only best-effort: revisions are throttled, not per-edit.

### The proposed solution

Add conflict *detection* at jonobones' own data plane, which is where it
belongs; the engine stays untouched. This is standard HTTP conditional-request
semantics (RFC 7232):

- On `GET` of an item, return an `ETag` header: an opaque validator that
  changes whenever the item changes.
- On a mutating request (`PATCH`, `DELETE`/restore), honor `If-Match: "<etag>"`:
  compare the presented validator against the item's current one. If they
  match, apply the write and return the new `ETag`. If they differ, reject with
  `412 Precondition Failed` and apply nothing.
- A contending agent, on `412`, re-reads the current item, re-applies its
  intended change (or escalates the conflict to a higher-level reconciler), and
  retries with the fresh `ETag`.

Validator: derive it from `updated_time` (already bumped to now on every save,
already indexed, already in the default field set) for the cheap default; a
content hash is the more robust upgrade if two serialized writes landing in the
same millisecond is a concern. Whichever is chosen, a sync-applied remote
change also bumps `updated_time`, so a stale client `ETag` is correctly
invalidated by sync as well as by a competing local writer.

### Northstar fit

Fidelity is preserved: this touches neither the Joplin data model nor the sync
contract; it is a control on the HTTP data plane only, exactly the layer the
axioms assign to jonobones. It adds no tables or files inside the Joplin
profile. It extends the API rather than asking clients to peek behind it.

### Open questions / trade-offs

- Advisory or mandatory. Honoring `If-Match` only when present is
  backward-compatible and keeps the API usable for simple, non-contending
  clients; requiring it on every write forces every writer to be
  conflict-aware but breaks trivial clients. A per-profile config could make
  the strict mode opt-in. Advisory is the likely default.
- Whole-item validator is conservative. A whole-item `ETag` treats *any*
  concurrent change as a conflict, including a disjoint-field edit that would
  otherwise have merged cleanly, so it can produce a `412` where no data would
  actually have been lost. That is standard HTTP behavior (an `ETag` covers the
  whole representation); field-level validators would recover the disjoint case
  but cost far more complexity than they are worth. Accept the conservative
  behavior; the agent just re-reads and retries.
- Scope. Which write endpoints to guard: item `PATCH`/delete/restore certainly;
  tag attach/detach and the `user_data` envelope endpoints are already
  last-write-merged per key by Joplin, so they may not need it. Resource blob
  writes are a separate question.
- This detects; it does not merge. Reconciliation stays the client's job, by
  design (jonobones is built for no particular client).

Verification note: the last-writer-wins conclusion is read from the 3.6.3
source, not reproduced with a live race; a concurrent same-field `PATCH` test
against a running daemon would confirm it empirically before promotion.
