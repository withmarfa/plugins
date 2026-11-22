**Use for:** asking for every ticket at once. A ticket is work someone wants done, or a question they want answered, tracked until it is finished or dropped. Write each one as a kind, never as a plain ticket: `common.ticket.epic`, `.feature`, `.spike` or `.task`.

**Not for:** a personal to-do or reminder, which is a `core.task`; a record of work already done, which is a note; an issue another tracker holds, which its connector brings in under its own type.

**Body:** `title` names the work, `description` is the line a board shows, and `body` holds the detail. A ticket's steps are a list in its body, not more tickets. `status` is `backlog` while parked, `not_started` once committed, then `in_progress`, `completed` or `canceled`; keep finished tickets. `assignees` names who is doing it.

**Edges:** `parent-of` runs from an epic to each of its tickets, and a ticket has at most one parent. `derived-from` runs from the ticket to what it was made from, such as a note, a message or a spike.
