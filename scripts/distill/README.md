# Local feedback loop (this machine only)

Turn knocks you already answered into a **proposed** `skills[]` menu, and
measure whether that menu would have made the next visitor’s first knock
useful.

Nothing here uploads visitor text, DIDs, or traces. The Distiller is not
imported by `muretai-agent-entry.mjs`.

```
npm run distill              # fixtures → skills.json → holdout measure
npm run distill -- --m0      # also run the door conformance suite
npm run distill:record       # print the observer snippet
```

## Record (optional)

`createAgentEntry({ observer: fileSink() })` appends POST outcomes to
`var/traces.jsonl` (gitignored). Card/notice GETs are dropped. DIDs are
not written. The door still discards the observer’s return — a full disk
cannot change a signed reply.

## Admission

Publish the proposed menu onto *your* card only when:

1. holdout first-knock useful rises
2. emptying the Distiller kills that lift
3. every proposed `examples[]` entry is answerable by *your* responder
4. the door conformance suite is still green

This package never patches a stranger’s `skills[]`.
