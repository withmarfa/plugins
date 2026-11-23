# marfa-connector-host

`marfa-connector-host` runs the connectors your Marfa assigns to a machine. It
links the machine to your Marfa once, then runs as a background service: it
asks Marfa which connectors to run, fetches their code, gives each one a key
of its own and restarts, pauses or removes them as you choose in Marfa.

## Install

Releases don't carry the host yet, so build it from this repository on Node
26 (the release `host/node.json` pins):

```sh
pnpm install --frozen-lockfile && pnpm build
```

Make a one-time link in your Marfa, then give it to the host within 15
minutes:

```sh
marfa hosts add "Studio Mac"
node host/dist/main.js install '<link>'
```

On macOS this loads the LaunchAgent `so.marfa.connector-host`; on Linux it
enables the systemd user unit `marfa-connector-host.service` and prints the
`loginctl enable-linger` command that keeps it running while you're logged
out. With `--no-service`, it installs no service, and you run
`marfa-connector-host run` under your own supervisor. Installing again with a
new link replaces the host's identity and deletes every connector's key and
code.

## Status, logs and uninstall

Until the host is on your `PATH`, run `node host/dist/main.js` in place of
`marfa-connector-host`.

```sh
marfa-connector-host status          # the host, and each connector it runs
marfa-connector-host logs [<plugin>]  # the host's log, or one connector's
marfa-connector-host uninstall       # removes the service and every file
```

After you uninstall, remove the host from your Marfa with
`marfa hosts remove <host>` so its connectors can run elsewhere.

## Files

The host keeps its files in `~/Library/Application Support/Marfa/Connector Host/`
on macOS, `$XDG_DATA_HOME/marfa/connector-host/` (by default
`~/.local/share/marfa/connector-host/`) on Linux, or the folder
`MARFA_CONNECTOR_HOST_HOME` names:

- `host.json`: the Marfa address and the host's name and ID.
- `host.key`: the host's own key, mode 600.
- `connectors/<plugin>/key`: each connector's key, mode 600.
- `connectors/<plugin>/code/<sha256>.mjs`: each connector's code.
- `logs/host.log` and `logs/<plugin>.log`: each capped at 4 MiB, with one
  older file kept.

No key is printed, logged or passed on a command line.

## What it fetches

- `GET /connector-hosts/self` from your Marfa every minute, with the host's
  key: which connectors to run, and how.
- `POST /connector-hosts/self/connectors/<plugin>/key`, to mint a connector's
  key when it has none, after Marfa refused it, or for a new version.
- Each connector's code, from the `https` address its plugin names. The host
  stops a download that passes the plugin's stated size and keeps the file
  only when its SHA-256 matches.
- When a connector fails before it registers, the host registers it with the
  connector's own key and reports one failed run, so you see the failure in
  Marfa.

Each connector runs under Node's permission model: it can read only its own
code file, reach the network and start workers, and it gets only
`MARFA_API_URL`, `MARFA_API_KEY`, `PATH`, `HOME`, the locale and time zone,
and the `OTEL_*` settings when the host has `OTEL_EXPORTER_OTLP_ENDPOINT` set.
