# Todoist

Reads the tasks of one Todoist account into Marfa through the Sync API, and carries changes made to those tasks in Marfa back to Todoist.

## What it brings

| Kind   | Type           | Carries changes back |
| ------ | -------------- | -------------------- |
| `task` | `todoist.task` | Yes                  |

## Add it

1. Install the plugin: `marfa plugins install todoist`.
2. Assign it to a connector host: `marfa plugins assign todoist --host <host>`. The host mints the connector's key.
3. Store your Todoist API token: `marfa plugins secret todoist todoist_api_token`.
4. To try it against a real account without writing back, set `marfa plugins settings todoist --set todoist_read_only=true`.
5. Optionally map the kind to your own type and tier: `marfa plugins mapping show todoist`, then `marfa plugins mapping set todoist <file>`.

## Read more

- Marfa's docs: [Todoist](https://docs.marfa.so/catalog/connectors/todoist), and [Give a connector its settings and secrets](https://docs.marfa.so/use/connector-settings).
- Every setting, with its default: [`plugin/plugin.json`](./plugin/plugin.json).
