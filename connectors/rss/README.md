# RSS

Reads Atom, RSS and JSON feeds into Marfa, one item for each entry. It only reads: nothing goes back to a feed. By default it keeps the addresses of an entry's pictures. If you ask, it also saves the pictures as files attached to the entry.

## What it brings

| Kind      | Type          | Carries changes back |
| --------- | ------------- | -------------------- |
| `entry`   | `rss.entry`   | No                   |
| `picture` | `rss.picture` | No                   |

## Add it

1. Install the plugin: `marfa plugins install rss`.
2. Assign it to a connector host: `marfa plugins assign rss --host <host>`. The host mints the connector's key.
3. Store the feeds to read, one address per line, with `marfa plugins secret rss rss_feeds`. It reads the value from standard input, because an address may hold a token.
4. Optionally save pictures: `marfa plugins settings rss --set rss_pictures=save`.
5. Optionally map the kinds to your own types and tiers: `marfa plugins mapping show rss`, then `marfa plugins mapping set rss <file>`.

## Read more

- Marfa's docs: [RSS](https://docs.marfa.so/catalog/connectors/rss), and [Give a connector its settings and secrets](https://docs.marfa.so/use/connector-settings).
- Every setting, with its default: [`plugin/plugin.json`](./plugin/plugin.json).
