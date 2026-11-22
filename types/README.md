# Common type families

A common type family is a set of shared `common.*` types, such as `common.ticket` and its kinds, together with guidance on how to use them. It belongs to no app, service or person. Each family is a plugin that an owner adds to their Marfa when they want its types.

Each family gets its own folder here, `types/<name>/`, which holds:

- `plugin.json`, with the plugin's `name`, `title`, `description`, `mark`, `maker` and `marfa`, the oldest Marfa release it supports. It names no version: a release stamps the version from its tag.
- `types/`, with one `<id>.json` for each type and its guidance in `<id>.md` beside it.
- Optionally, `edge-types/`, with one `<id>.json` for each edge type.

A pull request checks each folder as installing it will, with `marfa plugins check`. A version tag publishes a release that holds the bundle of every family, and `marfa plugins install <name>` adds a family to a Marfa from it. The first family, Tickets, is on its way.

Connectors, the other kind of plugin in this repository, live in [`connectors/`](../connectors).
