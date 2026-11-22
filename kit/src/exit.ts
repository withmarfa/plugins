/** What a connector's process exits with, so its host knows what to do next. */
export const exitCode = {
  /** Stopped cleanly. */
  stopped: 0,
  /** A run or the start failed for any other reason: back off and restart. */
  failed: 1,
  /** The connector's own definition or command line is wrong: restarting
   *  mends nothing until the code changes. */
  definition: 2,
  /** Marfa refused the key, or the kit refused it as not the connector's:
   *  mint it once, then stop. */
  key: 3,
  /** A required setting is missing, a value is invalid, or a run threw
   *  SettingsRefused: wait for the settings to change. */
  settings: 4,
} as const;
