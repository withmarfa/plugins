**Use for:** an issue in a repository the GitHub connector syncs: a task whose title, body, status, labels and assignees travel both ways when the connector runs as a GitHub App. With a personal token it is read only.

**Status:** open until GitHub closes it as completed, canceled (not planned) or duplicate.

**Not for:** a pull request, which is `github.pull_request`.

**Edges:** `github.in-repository` runs to its repository. `github.sub-issue-of`, `github.blocked-by`, `github.relates-to` and `github.duplicate-of` run between issues, and `github.closed-by` runs to the pull request that closed it.
