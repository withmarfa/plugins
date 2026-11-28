/** Readwise cuts a highlight's text at this many characters. */
export const readwisePassageLimit = 8_191;

/**
 * The passage a highlight holds as Markdown, whole: the export passage keeps
 * pictures and formatting that Reader's plain passage drops, unless Readwise
 * cut it at its limit, and then Reader's passage is the whole one.
 */
export function highlightPassage(text: string, exportText: unknown): string {
  return typeof exportText === "string" &&
    exportText.trim() !== "" &&
    (exportText.length < readwisePassageLimit || text.trim() === "")
    ? exportText
    : text;
}
