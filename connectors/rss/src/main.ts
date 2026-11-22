import { main, settingsFromEnvironment } from "@withmarfa/connector";
import { connector } from "./definition.js";

await main(connector(settingsFromEnvironment(process.env)));
