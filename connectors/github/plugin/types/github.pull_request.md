**Use for:** a pull request in a repository the GitHub connector syncs. Read only: its title, body and status come from GitHub.

**Status:** draft or open while the pull request is open, merged once merged, and closed when closed without merging.

**Fields:** `checks` summarizes the checks on the head commit: the rollup state, non-zero check run counts by state and non-zero commit status counts by state. It is null when the commit has no checks, and kept as last read if GitHub refuses the token the checks.

**Edges:** `github.closes` runs to each issue it closes. `github.in-repository` runs to its repository.
