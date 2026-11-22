**Use for:** a discussion in a repository the GitHub connector syncs. Its title, body and open or closed state travel both ways when the connector runs as a GitHub App.

**Fields:** its category, answer and lock are read from GitHub and never sent back.

**Edges:** `github.in-repository` runs to its repository, and its comments are connected to it by `comments-on`.
