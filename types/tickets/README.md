# Tickets

Tickets lets you track work and questions in Marfa, from backlog to done. It adds `common.ticket` and four kinds of ticket:

| Type                    | Use it for                                                      |
| ----------------------- | --------------------------------------------------------------- |
| `common.ticket`         | Any work or question you want tracked, when no kind fits.       |
| `common.ticket.epic`    | An outcome made of several tickets. Its tickets sit beneath it. |
| `common.ticket.feature` | A change that people using a product or service would notice.   |
| `common.ticket.spike`   | A question to answer before deciding or building.               |
| `common.ticket.task`    | Other work, such as upkeep, setup or a fix.                    |

A ticket is a task (`core.task`), so it has a title, description, body, status, priority, due date and assignees. Tickets adds one status, `backlog`, for work you want but have not committed to.

Each type carries guidance that tells an agent when to use it and how to fill it in.

## Install

```sh
marfa plugins install tickets
```
