**Use for:** a Readwise highlight with its complete passage and annotation. With Reader off, the rows come from Readwise's export and are read only. With Reader on, a highlight made in Reader is the same row, `readwise_text` holds the export's passage when it differs from Reader's, and edits to `note` and `tags` go back to Reader unless that is turned off.

**Text:** the whole passage as Markdown, pictures included, as the export holds it. With Reader on, `text` holds Reader's passage where the export has none or Readwise cut it at its limit. Marfa names a highlight after its source through `excerpt-of`, never after its passage. `note` is the separate annotation. `title` and `body` are no longer written.

**Edges:** `excerpt-of` runs to its source, a passage taken from it, not a mention.
