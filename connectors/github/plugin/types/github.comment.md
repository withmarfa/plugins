**Use for:** a comment on an issue or a discussion in a repository the GitHub connector syncs. Its body travels both ways when the connector runs as a GitHub App.

**Edges:** `comments-on` runs to the issue or discussion it is on. A reply on a discussion is also a child of the comment it answers, through `parent-of`. `github.in-repository` runs to its repository.
