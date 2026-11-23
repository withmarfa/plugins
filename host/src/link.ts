/** A one-time link that cannot be used, with the reason in plain words. */
export class LinkRefused extends Error {
  override name = "LinkRefused";
}

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The instance and the code a one-time link holds: `<origin>/connect#<code>`.
 * An `http` link is taken only for this machine, since the host's key and
 * every connector key cross it.
 */
export function parseLink(text: string): { origin: string; code: string } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new LinkRefused(
      "That is not a connector host link. Copy the whole link Marfa gave you, such as https://marfa.example.com/connect#…",
    );
  }
  const code = url.hash.slice(1);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.pathname !== "/connect" ||
    url.search !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    code === ""
  ) {
    throw new LinkRefused(
      "That is not a connector host link. A link looks like https://marfa.example.com/connect#… with the code after the #.",
    );
  }
  if (url.protocol === "http:" && !loopback.has(url.hostname)) {
    throw new LinkRefused(
      `The link names ${url.origin}, which is not https. A connector host only links to an instance over https, or over http on this machine.`,
    );
  }
  return { origin: url.origin, code };
}
