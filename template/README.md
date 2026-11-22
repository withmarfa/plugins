# A new connector

A connector is a small folder: `src/definition.ts` says what the connector is and what one run reads from its vendor, and `src/main.ts` starts it. The kit, `@withmarfa/connector`, does the rest: it registers the connector, reads its settings from Marfa, writes only what changed, carries changes made in Marfa back to the vendor where you ask it to, and reports each run. The kit's exported types and their comments in `kit/src/define.ts` describe each option.

## Start one

1. Copy the template without its build output and installed packages, and set `name` in the copy's `package.json` to `<name>`:

   ```bash
   mkdir connectors/<name>
   cp -R template/connector/package.json template/connector/tsconfig.json template/connector/src template/connector/test template/connector/plugin connectors/<name>/
   ```

2. Add `{ "path": "connectors/<name>" }` to the references in the root `tsconfig.json`.

## Define the connector

1. Replace `src/example.item.json` with the type the connector writes, and write its guidance, at most 1,000 characters, in `plugin/types/<id>.md`.
2. In `src/definition.ts`, name the connector and its plugin (`title`, an Iconify `mark` and `maker`), its `source` and the source's name and mark. Give it `kinds`, each with a `name`, a `direction` (`in`, `out` or `both`) and a type with the `fields` the vendor holds. Declare the `settings` it reads, each with a lowercase snake case `name`, a `label` and a `kind` (`text`, `number`, `boolean` or `choice`), and `secret`, `default`, `required` or `choices` where they apply. Write `run`, which reads the vendor and hands what it found to `upsert`, and what the vendor deleted to `archive`.
3. Export the definition as `connector()` and read no `process.env` in it. The owner sets each setting in Marfa, and the kit reads it from there at the start of every run.
4. To carry changes back, give each type a `link_field`, the property that holds the vendor's own id, and write `onChange`. A row made by hand in a type with a link goes to the vendor, so something meant to stay in Marfa belongs in a core type.

## Generate the plugin folder

After `pnpm build`, run `pnpm connectors:generate`. It writes the rest of `plugin/`: `plugin.json`, a type file for each kind and an edge type file for each connection type Marfa does not ship. `pnpm connectors:check` fails when any of them is out of date or a type has no guidance. Never edit them by hand.

## Test

`test/connector.test.ts` runs the example as a process against a scripted server and a stub vendor. Rewrite it for your connector. `test/quiet-run.test.ts` runs the kit's shared quiet-run test: keep it, with `hold` starting your vendor's stub holding the given number of items. Then run:

```bash
pnpm install && pnpm build && pnpm test
```

The install adds the connector to `pnpm-lock.yaml`, so commit the lockfile with the connector.

## Run it under a host

A connector starts from the key its connector host mints for it, never from a key you make by hand. Install the plugin, link a host and assign the connector to it, as [Run a plugin's connector on a connector host](https://docs.marfa.so/use/run-a-plugin-connector) says:

```bash
marfa plugins install connectors/<name>/plugin
marfa hosts add "<machine>"
marfa plugins assign <name> --host "<machine>"
```

Owners set the settings with `marfa plugins settings <name> --set <setting>=<value>` and each secret with `marfa plugins secret <name> <setting>`. The host starts the connector with its key, and the connector keeps no file: its state and settings are on the instance.

To run on a schedule outside a host, `launchd.plist.example` and `Dockerfile` in this folder show a LaunchAgent and a container image.
