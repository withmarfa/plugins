**Use for:** an entry from an Atom, RSS or JSON Feed, as the RSS connector reads it: a bookmark with the entry's id in its feed, and the feed's origin and an identity hash beside the bookmark's fields.

**Body:** the entry's content, or its summary where that holds markup and the feed gives no content, converted from HTML to Markdown. **Description:** the summary as plain text, or the caption of its picture where the summary is only a picture. **Image:** the entry's image enclosure, else the first picture in its content or summary, else its media thumbnail.

**Edges:** the pictures saved from it are attached by `attached-to`.
