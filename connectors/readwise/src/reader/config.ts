import {
  contentMaxBytes,
  endpoint,
  identity,
  type PicturesSetting,
} from "../readwise.js";
import type { SettingValues } from "@withmarfa/connector";
import type { settings } from "../settings.js";
export interface ReaderConfig {
  account: string;
  reader: boolean;
  readerBase: string;
  exportBase: string;
  includeFeed: boolean;
  inboundOnly: boolean;
  propagatePurge: boolean;
  contentMaxBytes: number;
  pictures: PicturesSetting;
}
/**
 * What the connector does with the pictures a document's HTML draws from
 * other websites: `addresses` keeps only the addresses, in the HTML; `save`
 * saves each document's pictures as files attached to it, at the tier the
 * owner's mapping chose for them.
 */
export function picturesSetting(value: string | undefined): PicturesSetting {
  if (value === undefined || value === "addresses") return "addresses";
  if (value === "save") return value;
  throw new Error("readwise_reader_pictures must be addresses or save");
}
export function parseConfig(
  values: SettingValues<typeof settings>,
): ReaderConfig {
  identity(values.readwise_account, "source", 1);
  return {
    account: values.readwise_account,
    reader: values.readwise_reader,
    contentMaxBytes: contentMaxBytes(values.readwise_content_max_bytes),
    readerBase: endpoint(values.readwise_reader_api_url),
    exportBase: endpoint(values.readwise_api_url),
    includeFeed: values.readwise_reader_include_feed,
    inboundOnly: values.readwise_reader_inbound_only,
    pictures: picturesSetting(values.readwise_reader_pictures),
    propagatePurge: values.readwise_reader_propagate_purge,
  };
}
