**Use for:** work someone wants done, or a question they want answered, tracked until it is finished or dropped. Use a kind when one fits: `common.ticket.epic`, `.feature`, `.spike` or `.task`.

**Not for:** a personal to-do or reminder, which is a `core.task`; a record of work already done, which is a note; an issue another tracker holds, which its connector brings in under its own type.

**Body:** `title` names the work, `description` is the one line a board shows, and `body` holds the detail, kept short. A ticket's own steps are a list in its body, not more tickets. Set `status` to `backlog` while it is parked, `not_started` once it is committed, then `in_progress`, `completed` or `canceled`; keep finished tickets. `assignees` names who it waits on.

**Edges:** `parent-of` runs from an epic to each of its tickets, and a ticket has at most one parent. `derived-from` runs from the ticket to what it was made from, such as a note, a message or a spike.
