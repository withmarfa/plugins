# GitHub

Brings the repositories a token can reach into Marfa: their issues, discussions, comments and pull requests, with the relations between them, and optionally Markdown files from paths you choose and your notifications. With a GitHub App it also carries edits to issues, discussions and comments back to GitHub. With a personal access token it only reads.

## What it brings

| Kind              | Type                     | Carries changes back |
| ----------------- | ------------------------ | -------------------- |
| `repository`      | `github.repository`      | No                   |
| `issue`           | `github.issue`           | Yes, with an App     |
| `comment`         | `github.comment`         | Yes, with an App     |
| `discussion`      | `github.discussion`      | Yes, with an App     |
| `pull_request`    | `github.pull_request`    | No                   |
| `notification`    | `github.notification`    | No                   |
| `file`            | `github.file`            | No                   |
| `file_image`      | `github.file.image`      | No                   |
| `repository_file` | `github.repository_file` | No                   |
| `directory`       | `github.directory`       | No                   |

## Add it

1. Install the plugin: `marfa plugins install github`.
2. Assign it to a connector host: `marfa plugins assign github --host <host>`. The host mints the connector's key.
3. Create a fine-grained personal access token with read access to Issues, Discussions, Pull requests, Commit statuses, Contents and Starring, then store it: `marfa plugins secret github github_personal_token`. This is the only setting a read-only connector needs. To carry changes back, use a GitHub App instead: set `github_app_id`, and the secrets `github_private_key` and `github_webhook_secret`.
4. Optionally narrow what it reads: `marfa plugins settings github --set github_repositories="owner/repo owner/*"`.
5. Optionally map the kinds to your own types and tiers: `marfa plugins mapping show github`, then `marfa plugins mapping set github <file>`.

## Read more

- Marfa's docs: [GitHub](https://docs.marfa.so/catalog/connectors/github), and [Give a connector its settings and secrets](https://docs.marfa.so/use/connector-settings).
- Every setting, with its default: [`plugin/plugin.json`](./plugin/plugin.json).
