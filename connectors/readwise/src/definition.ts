import { defineConnector, type Item, type Entry } from "@withmarfa/connector";
import { contentMaxBytes, endpoint } from "@withmarfa/readwise";
import { identity } from "@withmarfa/readwise";
import { highlightsPolicy } from "./coexistence.js";
import { settings, sync } from "./sync.js";
import {
  sourceType,
  highlightType,
  sourceFields,
  highlightFields,
  readerFileType,
  readerFileFields,
  readerFilePolicy,
} from "@withmarfa/readwise";

export function connector() {
  let account: string | undefined;
  return defineConnector({
    name: "readwise",
    title: "Readwise",
    mark: "lucide:highlighter",
    maker: "WithMarfa",
    source: "readwise",
    sourceName: "Readwise",
    description:
      "Sources and complete highlights from one Readwise account, read only.",
    readme: "connectors/readwise/README.md",
    types: [
      {
        name: "source",
        direction: "in",
        type: sourceType,
        fields: sourceFields,
        policy: (item: Item | undefined, entry?: Entry) =>
          highlightsPolicy(sourceType.id, item, entry),
      },
      {
        name: "highlight",
        direction: "in",
        type: highlightType,
        fields: highlightFields,
        policy: (item: Item | undefined, entry?: Entry) =>
          highlightsPolicy(highlightType.id, item, entry),
      },
      {
        name: "file",
        direction: "in",
        type: readerFileType,
        fields: readerFileFields,
        policy: (item, entry) => readerFilePolicy(account, item, entry),
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
    settings,
    checkEnv(values) {
      identity(values.readwise_account, "source", 1);
      account = values.readwise_account;
      endpoint(values.readwise_api_url);
      contentMaxBytes(values.readwise_content_max_bytes);
    },
    run: sync,
  });
}
