# Readwise

Brings the sources and complete highlights of one Readwise account into Marfa, with their annotations and tags. With Reader turned on, it also brings Reader documents, highlights and available content, and carries supported edits back to Reader. By default, Reader is off and the connector writes nothing to Readwise.

## What it brings

| Kind        | Type                 | Carries changes back |
| ----------- | -------------------- | -------------------- |
| `source`    | `readwise.source`    | Yes, with Reader on  |
| `highlight` | `readwise.highlight` | Yes, with Reader on  |
| `file`      | `readwise.file`      | No                   |

## Add it

1. Install the plugin: `marfa plugins install readwise`.
2. Assign it to a connector host: `marfa plugins assign readwise --host <host>`. The host mints the connector's key.
3. Set the account label, a stable name of your choice such as `primary`: `marfa plugins settings readwise --set readwise_account=primary`.
4. Store your Readwise access token: `marfa plugins secret readwise readwise_access_token`.
5. To bring Reader documents too, turn Reader on: `marfa plugins settings readwise --set readwise_reader=true`. Default: `false`, which writes nothing to Readwise.
6. Optionally map the kinds to your own types and tiers: `marfa plugins mapping show readwise`, then `marfa plugins mapping set readwise <file>`.

## Read more

- Marfa's docs: [Readwise](https://docs.marfa.so/catalog/connectors/readwise), and [Give a connector its settings and secrets](https://docs.marfa.so/use/connector-settings).
- Every setting, with its default: [`plugin/plugin.json`](./plugin/plugin.json).
