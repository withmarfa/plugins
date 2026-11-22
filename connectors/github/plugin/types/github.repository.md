**Use for:** a repository the GitHub connector syncs through a token or GitHub App, or one you have starred. Read only: GitHub is the source.

**Not for:** a repository you keep notes about yourself.

**Fields:** `synced` is true for a repository the connector syncs, and false for one kept only because you starred it. `starred` and `starred_at` are set from your stars, unless the connector is told not to read them.

**Edges:** its issues, discussions, comments, pull requests, files and directories are connected to it by `github.in-repository`.
