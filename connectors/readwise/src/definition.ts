import { defineConnector } from "@withmarfa/connector";
import {
  sourceType,
  highlightType,
  sourceFields,
  highlightFields,
  readerMutableSourceFields,
  readerMutableHighlightFields,
  readerFileType,
  readerFileFields,
  readerFilePolicy,
} from "./readwise.js";
import { settings } from "./settings.js";
import { parseConfig } from "./reader/config.js";
import { readerArchived } from "./reader/sync.js";
import { onChange, preflight } from "./reader/outbound.js";
import { rowPolicy, type PolicyConfig } from "./policy.js";
import { sync } from "./sync.js";

export function connector() {
  let config: PolicyConfig | undefined;
  const fromReader = new Set<string>();
  return defineConnector({
    name: "readwise",
    title: "Readwise",
    mark: "lucide:highlighter",
    maker: "WithMarfa",
    source: "readwise",
    sourceName: "Readwise",
    description:
      "Sources and complete highlights from one Readwise account, and, when turned on, Reader documents with supported two-way edits.",
    readme: "connectors/readwise/README.md",
    settings,
    checkEnv(values) {
      const parsed = parseConfig(values);
      config = {
        account: parsed.account,
        reader: parsed.reader,
        inboundOnly: parsed.inboundOnly,
      };
    },
    types: [
      {
        name: "source",
        direction: "both",
        type: sourceType,
        fields: sourceFields,
        readOnly: sourceFields.filter(
          (field) =>
            !(readerMutableSourceFields as readonly string[]).includes(field),
        ),
        policy: (item, entry, archiving) =>
          rowPolicy(sourceType.id, config, item, entry, archiving, fromReader),
        archived: readerArchived,
      },
      {
        name: "highlight",
        direction: "both",
        type: highlightType,
        fields: highlightFields,
        readOnly: highlightFields.filter(
          (field) =>
            !(readerMutableHighlightFields as readonly string[]).includes(
              field,
            ),
        ),
        policy: (item, entry, archiving) =>
          rowPolicy(
            highlightType.id,
            config,
            item,
            entry,
            archiving,
            fromReader,
          ),
      },
      {
        name: "file",
        direction: "in",
        type: readerFileType,
        fields: readerFileFields,
        policy: (item, entry) => readerFilePolicy(config?.account, item, entry),
      },
    ],
    retired: [{ type: highlightType.id, connection: "references" }],
    connections: [
      {
        id: "excerpt-of",
        label: "Excerpt of",
        cardinality: "many-to-one",
        from_type_constraints: [highlightType.id],
        to_type_constraints: [sourceType.id],
      },
      // Retired: cleared on every highlight written, so one synced before holds
      // only `excerpt-of`.
      {
        id: "references",
        cardinality: "many-to-many",
        from_type_constraints: [highlightType.id],
        to_type_constraints: [sourceType.id],
      },
      {
        id: "attached-to",
        label: "Attached to",
        cardinality: "many-to-many",
        cascade_on_delete: "with-hosts",
        from_type_constraints: [readerFileType.id],
        to_type_constraints: [sourceType.id, highlightType.id],
      },
    ],
    // Nothing goes to Readwise unless Reader is on and may be written.
    carries: (values) => {
      const parsed = parseConfig(values);
      return parsed.reader && !parsed.inboundOnly
        ? [sourceType.id, highlightType.id]
        : [];
    },
    run: (context) => sync(context, fromReader),
    preflight,
    onChange,
  });
}
