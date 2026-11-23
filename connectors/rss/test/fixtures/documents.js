// Documents built to strain a read, shared by the tests that measure one in
// a process of its own.
const rss = (channel) =>
  `<?xml version="1.0"?><rss version="2.0"><channel>${channel}</channel></rss>`;

/** Few elements, each with thousands of attributes: under the element and
 *  entry counts, and far over the attribute count. */
export function heavyDocument() {
  const attributes = Array.from({ length: 4000 }, (_, at) => `a${at}="v"`).join(
    " ",
  );
  const item = `<item><title ${attributes}>t</title><guid>g</guid></item>`;
  return rss(
    `<title>T</title>${item.repeat(Math.floor((44 * 1024 * 1024) / item.length))}`,
  );
}

/** A channel title under the field cap, which every one of thousands of small
 *  entries carries. */
export function sharedDocument() {
  const items = Array.from(
    { length: 4000 },
    (_, at) => `<item><title>${at}</title><guid>${at}</guid></item>`,
  ).join("");
  return rss(`<title>${"t".repeat(90000)}</title>${items}`);
}

/** As many attributes as the count allows, in few elements: the most that a
 *  feed of this shape asks of a read. */
export function attributeDocument() {
  const attributes = Array.from({ length: 4000 }, (_, at) => `a${at}="v"`).join(
    " ",
  );
  const item = `<item><title ${attributes}>t</title><guid>g</guid></item>`;
  return rss(`<title>T</title>${item.repeat(249)}`);
}

/** As many elements as the count allows, each with a few attributes. */
export function wideDocument() {
  return rss(`<title>T</title>${'<x a="1" b="2" c="3"/>'.repeat(299_000)}`);
}

const names = (count) => Array.from({ length: count }, (_, at) => `a${at}`);

/** Millions of attributes with no value, in one element. */
export function bareAttributesDocument() {
  return rss(`<title>T</title><x ${names(3_000_000).join(" ")}/>`);
}

/** Millions of attributes with an unquoted value, in one element. */
export function unquotedAttributesDocument() {
  return rss(
    `<title>T</title><x ${names(3_000_000)
      .map((name) => `${name}=1`)
      .join(" ")}/>`,
  );
}

const withDescription = (markup) =>
  rss(
    `<title>T</title><item><title>t</title><guid>g</guid><description><![CDATA[${markup}]]></description></item>`,
  );

/** One entry whose markup holds millions of elements. */
export function manyElementsDocument() {
  return withDescription("<b>x</b>".repeat(2_500_000));
}

/** One entry whose markup nests millions of elements deep. */
export function nestedElementsDocument() {
  return withDescription("<div>".repeat(3_000_000));
}
