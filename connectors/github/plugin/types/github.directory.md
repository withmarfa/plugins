**Use for:** a directory that holds Markdown files the connector syncs from a repository, as a collection of those files. Read only: GitHub is the source, and a change made in Marfa is put back on the next run.

**Edges:** it is a child of its parent directory, through `parent-of`, where that is synced too. `github.in-repository` runs to its repository.
