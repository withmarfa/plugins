**Use for:** a Readwise highlight with its complete passage and annotation. With Reader off, the rows come from Readwise's export and are read only. With Reader on, a highlight made in Reader is the same row, `text` holds Reader's passage and `readwise_text` the export's when they differ, and edits to `note` and `tags` go back to Reader unless that is turned off.

**Body:** the whole passage as Markdown, pictures included. **Title:** the passage's first paragraph as plain text, cut at a word boundary to at most 80 characters. `note` is the separate annotation.

**Edges:** `excerpt-of` runs to its source, a passage taken from it, not a mention.
