---
name: project-priority
description: >-
  Decide which APPL project is started next when a worker slot is free. Use
  whenever an agent chooses a project, ranks repositories, edits
  project-priority, sees a slot or `blocked after` intake, or the person says
  priority, 優先, which project first, or what to spawn next. Read the
  coordinator file. Do not invent an order from age, P0, or taste.
---

# Which project APPL starts next

The order of projects is one file. It is not a guess, and it is not an intake's P0.

## Read this file

`$HERD_DIR/coordinator/project-priority`, or `~/.cache/muretai-herd/coordinator/project-priority` when `HERD_DIR` is unset.

One project per line. The top line is first. A `#` line is a comment. A line is either the repository directory's basename (`agent-entry-go`) or that repository's absolute path. A basename matches the last component of the intake's `repo:` path.

No file, or a line that matches nothing: that intake sorts after every listed project. Inside one rank, the older intake file name is first.

## What a free slot starts

When the coordinator pane is idle or done, and fewer workers are `working` or `blocked` than the number in `coordinator/worker-cap`, herd-watch types one `intake <path>` and logs `slot <file name>`. That intake is the choice. Spawn that one. Do not pick a different project in the same turn.

Eligible intakes are those whose status is exactly `blocked after`, and those whose first status word is `new` and whose file is still inside 300 seconds. A status that names a live worker is not eligible. `blocked owner-step`, `question`, `parked`, `done`, and any other `blocked <why>` are not eligible.

## Do not invent a rank

- Do not reorder projects because an intake says P0, `owner-priority: P0`, or "urgent". Those words order items inside the backlog pull. They do not move a project up this file.
- Do not write `blocked after` to put a project behind another, or to end a turn while a slot is free.
- Do not start a lower line while a higher line still has an eligible intake.
- Do not edit `project-priority` unless the owner stated the order. Then write only the lines they named, top line first, and leave every other intake status alone.
