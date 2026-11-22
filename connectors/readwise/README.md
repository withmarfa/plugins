# Readwise

Import sources, complete highlights, annotations, and tags from one Readwise account into Marfa. With the `readwise_reader` setting on, the same connector also keeps Reader documents, highlights, annotations, and available content, and carries supported edits back to Reader. With it off, which is the default, nothing is written to Readwise. The connector reads the export, and, for a row Reader managed before, refreshes that row from Reader with GET requests. It polls through the connector kit and keeps progress on the Marfa instance.

On every start the connector gives its source `readwise` the name Readwise, so apps show it instead of the code, and sets it only where the source has no name set, so a name an owner chose in an app is kept. Neither icon set Marfa accepts has a mark for Readwise, so it sets none.

## Data model

`readwise.source` inherits `core.media`. It represents a book, article, tweet, podcast, or another source exported by Readwise, and, with Reader on, a Reader document. `readwise.highlight` inherits `core.highlight` and keeps the complete passage and annotation. Each highlight declares an `excerpt-of` edge to its source: a passage taken from it, not a mention. `readwise.file` holds content Reader keeps for a document; see [Preserve content](#preserve-content).

Source notes map to `notes`, summaries to `description`, and valid web source and cover URLs to `url` and `image_url`. Readwise's original addresses, such as `source_url` and `readwise_url`, are kept in their own fields, which accept any absolute URL. A blank title falls back to `readable_title`, then `Readwise source <ID>`.

A valid highlighting time supplies the item's `occurred_at`; a valid update time supplies the kit's conflict-resolution timestamp. The original timestamps remain available in properties. `time_offset` maps to the core `time` locator; page, offset, order, none, and cfi retain their meaning. Original location kinds, numeric locations, and colors are retained even when core enums cannot represent them. Text and annotations are never truncated. Tags from strings or named objects are trimmed and deduplicated without changing case or Unicode.

### Highlight titles

A highlight shows its `title` and `body`. `body` is the whole passage as Markdown, pictures included, exactly as Readwise gives it. `title` is the passage's first paragraph as plain text, without Markdown, cut at a word boundary to at most 80 characters with an ellipsis. A blank line ends a paragraph, and a Markdown heading is a paragraph of its own; a single line break, such as one Reader puts around a link or a soft wrap, reads as a space. The title leaves out list and quotation markers at its start, a heading's permalink mark such as `#`, and any space before a closing punctuation mark or bracket. On a row Reader manages, the title comes from the export passage, which keeps the paragraph breaks that Reader's plain passage loses, or from Reader's passage when the export has no words; `body` is the export passage when there is one, and Reader's passage when Readwise cut the export at its 8,191-character limit. A heading in either passage ends the title, because the export can join a heading to the text after it. A passage with only a picture is titled `Picture from <document title>`, or `Picture` when the document's title is unknown. `text` keeps the passage as before, and `note` stays the separate annotation.

### Field kinds

Every timestamp field, such as `highlighted_at`, `readwise_created_at` and `reader_saved_at`, is a `datetime` field. `reader_published_date` is a `date` field. Every address field, such as `source_url`, `readwise_url` and `reader_image_url`, is a `url` field; an address is stored as Marfa stores any URL, trimmed and without tabs or line breaks. A value Readwise sends in another shape never stops a row from being written:

- A blank value is left out.
- Any other value the field refuses is left out of its field and kept, exactly as sent, in `original_values` under the field's name. It leaves `original_values` once Readwise sends a value the field accepts or no longer sends the field.

## Account identity

The caller supplies one stable, nonsecret account label. Labels have 1–64 ASCII letters, digits, dots, underscores, or hyphens and start with a letter or digit. Natural keys are `<account>:source:<ID>` and `<account>:highlight:<ID>`, separating the two independent ID sequences. Reader-only rows use `<account>:reader-document:<ID>` or `<account>:reader-highlight:<ID>`. Keep the label unchanged across token changes and reinstallations. The connector is designed for one account; the label is not inferred from a token or an undocumented account response.

## Run the connector

Build from the repository root with Node 22.13 or later:

```bash
pnpm install --frozen-lockfile
pnpm build
```

Install the plugin and assign its connector to a connector host, which mints the connector's key, as [the template's README](../../template/README.md#the-key) says:

```bash
marfa plugins install connectors/readwise/plugin
marfa plugins assign readwise --host "<machine>"
```

The key holds write on `readwise.source`, `readwise.highlight`, `readwise.file`, `excerpt-of`, `references` and `attached-to`, and nothing else.

The built-in `excerpt-of`, `references` and `attached-to` definitions are never changed. The connector clears the `references` it once wrote from a highlight to its source, so a highlight synced before holds only `excerpt-of`; that is why the key holds write on `references`. Installing the plugin registers the types. Turning Reader on or off keeps the same key, registration, rows and progress.

Set these settings in Marfa with `marfa plugins settings readwise --set <name>=<value>`, and the token with `marfa plugins secret readwise readwise_access_token`. The connector reads them at the start of every run. The environment holds only `MARFA_API_URL` and `MARFA_API_KEY`, the key its host minted.

| Setting                           | Meaning                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `readwise_access_token`           | Your Readwise access token, treated as a secret.                                                                                                                                                                                                                           |
| `readwise_account`                | Stable nonsecret account label, such as `primary`.                                                                                                                                                                                                                         |
| `readwise_content_max_bytes`      | Remote resource limit in bytes, from 1 through 1073741824 (1 GiB). Default: 268435456 (256 MiB).                                                                                                                                                                           |
| `readwise_api_url`                | Optional export API base for controlled testing. Default: `https://readwise.io/api/v2/`.                                                                                                                                                                                   |
| `readwise_reader`                 | `true` includes Readwise Reader. Default: `false`. Nothing is written to Readwise. A row Reader managed before is still refreshed from Reader with GET requests.                                                                                                           |
| `readwise_reader_include_feed`    | With Reader on, `true` includes feed documents. Default: `false`, saved library only.                                                                                                                                                                                      |
| `readwise_reader_inbound_only`    | With Reader on, `true` sends no edits to Reader. Default: `false`.                                                                                                                                                                                                         |
| `readwise_reader_propagate_purge` | With Reader on, `true` lets a permanent purge in Marfa delete the Reader record. Default: `false`.                                                                                                                                                                         |
| `readwise_reader_pictures`        | Pictures hosted on other websites: `addresses` lists them in the manifest only, `save` saves them, and `save-in-library` saves them only for documents in the Marfa library tier. Default: `addresses`. See [Pictures from other websites](#pictures-from-other-websites). |
| `readwise_reader_api_url`         | Optional Reader API base for controlled testing. Default: `https://readwise.io/api/v3/`.                                                                                                                                                                                   |

API overrides require HTTPS, except HTTP on loopback; credentials, query strings, and fragments are rejected. The token is sent only to the configured API bases.

Run once or poll with the kit's existing scheduler:

```bash
node connectors/readwise/dist/main.js --once
node connectors/readwise/dist/main.js --every 15m
```

A saved account label or endpoint cannot be changed in place. Restore the original configuration if startup reports a mismatch. Rotating the access token leaves identities and progress unchanged. The [template deployment guide](../../template/README.md) covers launchd and Docker; this connector does not install a scheduled service itself.

## Export validation

The parser requires a valid export envelope with a nonnegative count, explicit next-page cursor (a nonempty string or positive safe integer) or null, and source and highlight arrays. Numeric cursors, as returned by the live service, are normalized to strings without losing precision. The count describes highlights, not the number of sources. Invalid IDs, text, flags, or tag structures fail visibly instead of being treated as an empty account. Optional metadata can be absent or null where Readwise allows it. An explicit tombstone may omit passage text; mapping functions reject tombstones so the sync layer must handle them as archival operations that preserve existing content.

The connector requests explicit deletion records and archives only those records, retaining existing content. A source tombstone does not imply that its highlights are deleted. Missing records, empty pages, and HTTP 404 responses never imply deletion. Export tombstones do not archive rows Reader manages. User archives, trash and purge follow the kit's existing rules.

## Progress and recovery

Each run reads the export first and then, with Reader on, Reader. Reader still runs when the export fails, since the two answer from separate APIs, and the run reports the first failure.

The first run exports all records. Later runs use the previous completed walk's start time with a five-minute overlap. Each page is checkpointed only after its rows and applicable references are acknowledged, or its refused rows are durably retained for refetch by the kit. An interrupted walk retains its original start time, lower bound and cursor. An uncertain acknowledgement is resolved by reading saved state on the next run; repeated data keeps the same identities and does not rewrite unchanged items.

Incremental exports do not guarantee source-only metadata changes. A full rescan is due every 24 hours, and a changed effective field set also starts a full rescan. A run processes at most 50 pages of the main export before leaving the remaining walk for the next scheduled run. Repeated cursors fail visibly; a walk that exceeds 4,096 distinct cursors also stops with progress retained. Only an explicit invalid-cursor response restarts the same saved window.

Rejected rows use the kit's bounded refetch journal, even when every row on a page is rejected. A pending highlight is resolved through its detail endpoint to a source ID, then the complete source is exported by ID without an incremental filter. Missing answers leave the refusal pending; explicit tombstones settle deletion. A journal or checkpoint that cannot safely retain progress blocks advancement.

HTTP 429 responses save `Retry-After` deadlines across restarts. Missing or malformed guidance fails visibly without guessing a retry delay. Requests have a 30-second timeout, honor cancellation, reject redirects and limit decoded responses to 32 MiB. Authentication failures, malformed data and unavailable services do not become successful empty imports. Watch-only kit runs restore mirrored fields from existing agreements and do not poll Readwise or advance export progress.

With Reader on, Reader's listing starts from the last completed walk's start with a five-minute overlap. A full reconciliation is due daily. Expanded scope or effective fields trigger a backfill. The checkpoint retains the walk start, lower bound, cursor, configuration fingerprint, and rate-limit deadline. Invalid pages and repeated or rejected cursors never become an empty successful inventory. Bounded state refuses advancement rather than dropping identities.

## Reader

### Identity and one item per document

A Reader document and its export entry are one item: documents keep type `readwise.source` and highlights `readwise.highlight`. Existing item IDs and export natural keys remain unchanged when Reader is turned on. Verified Reader identities use the link `canonical_key`, `<account>:reader-document:<ID>` or `<account>:reader-highlight:<ID>`, including on archived and trashed rows. A later export ID enriches the same row; an absent export ID stays absent, and a Reader-only row has no fabricated export ID. Purged identities are not recreated, and conflicting holders produce a condition requiring investigation.

When a complete export explicitly identifies one active highlight and deleted historical aliases for the same Reader highlight, the connector adopts only the active alias after verifying its Reader parent. Historical aliases and retained historical rows stay intact. Missing lifecycle evidence or two active claims remain unresolved.

The identity catalog first completes the account-wide export, including deleted highlights. Later runs complete an overlapping, paginated `updatedAfter` walk before admitting lifecycle identities. Each overlap starts at the previous walk's start, and cursors survive restarts. The connector also reads every known alias source to verify current parents and lifecycle status. Alias identity consists of its natural key, export ID, and export source. Parent and lifecycle status are mutable provider observations: a later completed walk can correct earlier evidence, while conflicting observations within one walk remain unresolved. Retained local rows do not overwrite provider evidence. Unknown-parent claims remain attached to their highlight identity; an unrelated unknown parent does not block the account. This follows the [Readwise export API's full-then-incremental synchronization method](https://readwise.io/api_deets).

The identity index inspects retained states and known purge tombstones before admission. Conflicting holders or contradictory export evidence produce a condition and retain the pending identity for investigation. The connector never merges or deletes conflicting rows automatically. A local explicit create that may be recovering a request blocks matching inbound admission until its journal settles.

Reader supplies the canonical highlight passage in `text`. A differing export passage, which is Markdown and keeps pictures, remains in `readwise_text`. Note records retain their identities and metadata while their text is folded into the annotation. Unknown categories remain available.

### Which rows Reader owns

Reader owns verified Reader rows and explicit Reader creates, not every row of the two types. A row only the export holds, such as a Kindle book, is never carried to Reader: a change to one of its fields in Marfa is put back from the export, and its archive, trash or purge stays in Marfa. A row the export has from Reader, which Reader takes over, is not carried either, but a change in Marfa to a field Reader can edit stays. When Reader takes over a row the export wrote, its values come from Reader where nobody changed them in Marfa; a value changed in Marfa is kept and reported, and is not sent to Reader. Taking a row over never sends anything to Reader, so a row archived in Marfa while Reader was off stays archived without moving the document to Reader's archive. A later local edit does go to Reader. Reader metadata and unsupported fields remain inbound only. If Reader's answer to a write is lost and Reader is then turned off or set to inbound only, the write waits and is sent again only once Reader can be written; until then its row stays as it is in Marfa. A lost answer to an edit of a linked row leaves the rest of each run going. A lost answer to a create made in Marfa with `reader_create` has no link yet, so Marfa holds every row of its type: the run fails with "A save to Reader was sent but not confirmed", Readwise records no progress, and it imports nothing new. Nothing is sent and nothing is lost. Turn Reader back on with writes allowed, or wait until Reader can be written, and the save settles once; the next run then imports again.

With Reader off, rows Reader managed before keep their identity. The export still refreshes them from Reader with GET requests, keeps a value changed in Marfa without carrying it, and leaves their content preserved; turning Reader on again carries that value. Up to 20 managed document and known annotation lookups use direct requests. Larger sets use a complete validated Reader listing when its first page indicates no more requests than individual lookups. The listing retains only those managed identities and known annotations and does not authorize deletion. A failed Reader lookup never substitutes older export values. With Reader on, Reader's own listing keeps these rows current instead.

### Preserve content

Listing and preservation have independent scopes, and the export and Reader share one bounded preservation queue. A page acknowledges its content work before advancing. Listing completion does not mean preservation is complete: pending resources and retry conditions remain visible separately. Queue pressure drains ready work before admission; if capacity remains full, the listing keeps its cursor before the unaccepted row. An acknowledged manifest for the same canonical identity and revision avoids requeuing unchanged content. Grant `readwise.file=write` and `attached-to=write` before turning Reader on.

Each retained HTML document, available original, Readwise-hosted image, overflow text, and resource manifest has its own `readwise.file` item with a `blob_ref`. Every file has an `attached-to` edge to its source or highlight. Trashing a source or highlight in Marfa puts its files in the bin with it, and restoring it brings them back. Original HTML bytes are retained without rewriting links.

The manifest distinguishes kept, pending, unavailable, and deliberately unkept resources. A completed empty HTTP 200 download is recorded as unavailable without replacing any retained bytes; failed or incomplete downloads remain pending. Downloads accept only the verified HTTPS `readwise-assets.s3.amazonaws.com` host and validate each redirect. They never send API credentials to storage or fetch linked websites. Pictures hosted on other websites are fetched only when `readwise_reader_pictures` asks for them. Transient signed URLs are excluded from checkpoint and manifest metadata; original HTML remains exact. A changed or expired source link is refreshed through Reader. Failed downloads retain the last acknowledged bytes.

Downloads stream through a private temporary file, removed after success, failure, or cancellation; upload retries reopen that file without buffering the whole resource in memory. A resource above `readwise_content_max_bytes` remains pending with its byte limit reported, and its last acknowledged copy remains available. Raising the limit lets existing pending jobs retry at their recorded deadlines without starting a metadata backfill.

Each content pass handles a bounded number of documents and resources; later runs resume pending work. A productive pass that stops at its resource budget remains ready for the next pass. Failed or stalled work keeps its retry delay. Stable resource keys and acknowledged manifests avoid repeat uploads and unchanged downloads. Text that exceeds the item field limit is retained in a referenced text blob before its final metadata is acknowledged. A purged content item is not silently recreated.

### Pictures from other websites

A document's HTML often shows pictures hosted on other websites. Pictures on Readwise storage keep their own download path, whatever the setting. For a document that saves pictures, a picture is the absolute address in an `img` element's `src`, or in its `data-src` when it has no `src`, or the document's cover `image_url`. Each whole address is one picture, so two addresses that differ only in the query are two pictures. Other image references, such as `srcset` candidates and relative or `data:` addresses, stay listed as deliberately unkept, reason `third-party`, and are never fetched.

`readwise_reader_pictures` decides what happens to them:

- `addresses` (the default): nothing from another website is fetched. The manifest lists each image on another website as deliberately unkept, reason `third-party`, one resource for each origin and path.
- `save`: each HTTPS picture is fetched and saved. An `http:` address is never fetched and is listed as deliberately unkept, reason `not_https`.
- `save-in-library`: pictures are saved only for documents whose `readwise.source` row is in the Marfa library tier. Feed documents keep the `addresses` behavior.

Any other value stops the connector at start.

A saved picture is a `readwise.file` item with `resource_kind` `picture`, its bytes, `mime_type`, and `source_url` set to the picture's address. It has an `attached-to` edge to its source and takes the source's tier when it is created. The HTML is never rewritten: it keeps the original addresses. The manifest lists each picture with its saved file, and that file's `source_url` holds the address.

Picture work runs after the listing and content work of each scheduled run, in its own queue, apart from content preservation. Content preservation never fetches a picture and never waits for one: it lists a picture that is not yet saved as deliberately unkept, reason `third-party`, and a document's content is accounted for whatever its pictures. Picture work then takes each document whose content is accounted for, reads it from Reader once, saves its pictures, and writes the manifest again at the same revision, only while the manifest is still the accounted manifest of that revision. A run that a webhook hint started, or that Reader rate-limits, leaves picture work to the next run.

Pictures are fetched through the kit's picture fetcher. It refuses a redirect that is not HTTPS (reason `not_https`), private network addresses, known trackers, SVG, one-pixel images, and responses that are not pictures or are too large. A refused picture is recorded as unavailable with the refusal reason, and the HTTP status when there is one, and is not fetched again. The connector keeps the 1,024 most recent refusals in its saved state across runs and manifest rewrites. A timeout, a failed connection, a failed upload, or an HTTP 408, 425, 429, or 5xx response is retried on later runs, up to 3 attempts in all. One failed picture never fails its document or the run.

Each document saves at most 50 pictures; the rest are listed as deliberately unkept, reason `over-document-limit`. Each run fetches at most 100 pictures and 200 MiB, and stops starting fetches 10 minutes after its first picture fetch, so a slow listing leaves pictures their time. Once a run reaches a limit, it reads no more documents for pictures, reports the condition `readwise:reader-pictures-limit`, and the next run continues. Each run reads at most 25 documents for pictures, and at most 256 documents wait for picture work; when that queue is full, the connector reports `readwise:reader-pictures-backlog` and later goes over the kept documents again. A document whose picture work fails, whose content isn't accounted for yet, or whose picture needed its edge repaired is tried again on a later run, after a wait that doubles from 2 minutes up to 24 hours, as content preservation waits. It stays in the queue until its picture work finishes. If the saved picture-work state can't be read, the connector reports `readwise:reader-pictures-invalid`, starts again from an empty queue, goes over the kept documents again, and lets the listing continue; with the setting at `addresses`, it clears that state.

A picture is listed as kept only when Marfa holds it: an active `readwise.file` item with `resource_kind` `picture`, the picture's `source_url`, its bytes, and an `attached-to` edge to the document. This holds whatever the setting, so a manifest written with Reader off lists the pictures saved with it on. A saved picture that lacks its edge, as a run that stopped early can leave one, is written again with its edge and is listed as kept from the next run. If the edge still hasn't landed after 5 such repairs in a row, the connector stops writing the picture again, lists it as deliberately unkept, reason `third-party`, and reports a condition whose key is `readwise:pictures-repair:` followed by a hash of the document's canonical key. A picture that was trashed, archived, or purged in Marfa is listed as deliberately unkept, reason `removed`, and is not fetched again.

Turning the setting on doesn't walk the Reader listing again. Picture work goes over the documents already kept in Marfa instead, a bounded batch at a time, with one Reader request for each document. It uploads nothing that is already kept and changes no existing item except to add pictures and update the manifest. Turning the setting off stops picture work; turning it on again goes over the kept documents again.

### Archive and restore

Reader's archive and Marfa's `archived` state mean the same thing: finished with, but kept. With Reader on, the connector keeps the two in step for documents (`readwise.source`).

- After a run, a document whose `reader_location` is `archive` is `archived` in Marfa. One that has moved out of Reader's archive, to `new`, `later` or `feed`, is `active` again.
- Archiving a document's item in Marfa moves the document to Reader's archive. Restoring it to `active` moves the document to `later`. The connector stores no earlier location. If the document has already left Reader's archive, a restore changes nothing in Reader. `readwise_reader_inbound_only` turns this off, with the other edits to Reader.
- Highlights keep their own state. Archiving a document leaves its highlights active, as Readwise does: its documentation says to keep annotated documents in the Reader archive to preserve their highlights. Saved pictures stay active too, and are never listed as deliberately unkept because their document was archived.
- When both sides change in one run, the later change wins, as it does for other fields. A restore in Marfa is carried to Reader unless Reader changed the document after the restore, in which case Reader's change stands and the item is archived again.
- Archiving many documents in Reader at once is not a deletion. Only a document confirmed missing counts toward the limit of 20 described under [Deletion and reconciliation](#deletion-and-reconciliation).

A document that disappeared from Reader is archived too, but its `reader_location` is whatever Reader last reported, which is not `archive`. An archived item whose `reader_location` is `archive` is in Reader's archive, whichever side archived it; any other archived item is missing from Reader, was archived in Marfa before Reader took it over, or, with `readwise_reader_inbound_only` on, was archived in Marfa only.

### Edit and create

Supported document edits are title, author, summary (`description`), notes, tags, reading location (`reader_location`), category, language, publication date (`published_at`) and image (`image_url`). Highlights support annotation (`note`) and tags; `title` and `body` are read only. Empty notes and empty tag arrays are explicit clears. Only changed supported fields are sent. Body replacement, passage edits, progress writes, and original-file upload remain read-only.

To request a local create, use the type and matching `account`, and explicitly set `reader_create: true`. A source needs a stable HTTP URL. A highlight needs `reader_parent_id` and passage text. Do not invent a Reader ID or export ID. Ordinary local rows without this explicit intent are not created upstream.

Every vendor mutation is preceded by an acknowledged journal entry containing the exact request and recovery baseline. URL saves are read back before a separate acknowledged update phase applies intended fields. Readback is required before agreement. A missing update target is never recreated.

After an uncertain highlight create, recovery accepts exactly one new matching object absent from the pre-send inventory. Zero or multiple matches remain pending without another blind create. A definitive rate-limit refusal can be retried only after its durable deadline and after consuming the recorded no-apply evidence. Lost responses and ambiguous readbacks retain the immutable request for reconciliation. Definitive validation refusals remain visible so a corrected local edit can be tried.

### Deletion and reconciliation

Trash never changes Reader. Purge propagation is off unless explicitly enabled. Before any vendor mutation, the connector checks the complete pending purge set, including retries and provider cascades. More than 20 intended deletions fails the whole run before Reader is read: no change of any kind is carried to Reader and nothing is read from it. Each later run fails the same way until the count is 20 or fewer or purge propagation is turned off.

When a trash or purge overtakes a create whose answer was lost, Marfa never deletes at Reader, whether purge propagation is on or off: the person's Reader copy stays. If Reader refused the create, nothing new at Reader matches it, or Reader held the document before it, the connector changes nothing. If the connector can identify what the create made, from Reader's answer, its own journal, or the one new match for what it sent, it claims that document or highlight for the row: the import leaves it out, as it does an object whose row was purged, and restoring the row links it again with no second create. When the connector cannot settle the create, because more than one new object could be the create's, a new highlight of the same passage has a different note or tags, or Reader's inventory cannot be proved complete, the change stays pending. The connector keeps at most 1,000 claims. When a new claim would pass that, the connector drops the oldest one and logs a warning. A dropped claim loses nothing: Reader still holds the object, and if Reader lists it again, it can reappear in Marfa's feed tier.

An upstream disappearance requires a completed inventory and a successful empty direct lookup. A failed request, incomplete inventory, or excluded feed record does not establish deletion. More than 20 confirmed disappearances blocks archival of the whole set. Confirmed missing documents and their dependent highlights are archived explicitly, while content remains retained. A document in Reader's archive is not missing; see [Archive and restore](#archive-and-restore). Returning records reuse their existing identities.

## Replace the types

Normal scoped connector startup refuses to replace an existing incompatible schema, such as a change to a field's kind. When it does, it stops and names the `marfa types replace` command to run, with a credential that holds `schema.write`:

```bash
marfa types replace readwise.source --file connectors/readwise/src/readwise.source.json
marfa types replace readwise.highlight --file connectors/readwise/src/readwise.highlight.json
```

Back up the instance first, replace the types through that command and do not delete or recreate them, and read the definitions and rows back afterward. Replacing a type changes no stored item. Because the types changed, the next run reads the whole account again and rewrites each row in place, under the same natural key.

## Verify the connector

From the repository root:

```bash
pnpm exec vitest run connectors/readwise/test
pnpm proof --group readwise
pnpm proof --group readwise-with-reader
```

Fetch the proof server with `scripts/monorepo.sh` as described in the repository README. The proof uses disposable vendor fixtures. Its `readwise-with-reader` group runs one registration with Reader off and then on, and covers adoption of existing rows in every state, uncertain creates, refresh with Reader off, cleared fields, unchanged row, file and edge versions, oversized text, deletion limits, and readable archived blobs after housekeeping. Fixture results are not evidence of a live account import.

The mapping follows the [Readwise export API](https://readwise.io/api_deets#highlight-export) and the [Reader API](https://readwise.io/reader_api).
