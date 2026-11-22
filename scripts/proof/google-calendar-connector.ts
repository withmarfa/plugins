import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { main, type Connector } from "@withmarfa/connector";
import { isProgram } from "./program.js";

/** The built definition of the repository's Google Calendar connector. */
const built = resolve(
  import.meta.dirname,
  "../../../connectors/google-calendar/dist/definition.js",
);

/**
 * Runs the repository's own Google Calendar connector with Google's three
 * addresses pointed at the proof's stand-in, `PROOF_GOOGLE_URL`: the
 * connector's `main.js` reaches Google itself, which a proof never does.
 */
if (isProgram(import.meta.url)) {
  const base = process.env["PROOF_GOOGLE_URL"];
  if (base === undefined) throw new Error("PROOF_GOOGLE_URL is not set");
  const { connector } = (await import(pathToFileURL(built).href)) as {
    connector: (options: {
      endpoints: { token: string; userinfo: string; api: string };
    }) => Connector;
  };
  await main(
    connector({
      endpoints: {
        token: `${base}/token`,
        userinfo: `${base}/userinfo`,
        api: base,
      },
    }),
  );
}
