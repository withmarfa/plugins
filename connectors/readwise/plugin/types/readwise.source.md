**Use for:** a Readwise source, such as a book, an article, a tweet or a podcast, one row for each document of one Readwise account. With Reader off, the rows come from Readwise's export and are read only. With Reader on, a document saved in Reader is the same row, holding Reader's values beside the export's, and edits to its title, author, summary, notes, tags, location, category, language, publication date and image go back to Reader unless that is turned off.

**Body:** the source's notes and summary are `notes` and `description`. A blank title falls back to its readable title, then to `Readwise source` and its id.

**Edges:** each highlight is connected to its source by `excerpt-of`.
