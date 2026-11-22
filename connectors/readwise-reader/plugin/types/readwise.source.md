**Use for:** a Readwise source, such as a book, an article, a tweet or a podcast, one row for each document of one Readwise account. The Readwise and Readwise Reader connectors write the same row.

**Body:** the source's notes and summary are `notes` and `description`. A blank title falls back to its readable title, then to `Readwise source` and its id.

**Edges:** each highlight is connected to its source by `excerpt-of`.
