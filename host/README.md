# marfa-connector-host

`marfa-connector-host` runs the connectors your Marfa assigns to a machine. It
links the machine to your Marfa once, then runs as a background service: it
asks Marfa which connectors to run, fetches their code, gives each one a key
of its own and restarts, pauses or removes them as you choose in Marfa.

## Install

A release carries the host. This installs the newest one and links the
machine. Make a one-time link in your Marfa, then give it to the installer
within 15 minutes:

```sh
marfa hosts add "Studio Mac"
curl -fsSL https://github.com/withmarfa/plugins/releases/latest/download/install-host.sh | sh -s -- '<link>'
```

The script downloads that same release's archive for this machine
(`darwin-arm64`, `darwin-x64`, `linux-x64` or `linux-arm64`), checks its
SHA-256, unpacks it into a folder of its own beside any older copy, puts it
in place and links `marfa-connector-host`
on your `PATH` (`~/.local/bin`). It then runs
`marfa-connector-host install '<link>'`.

On macOS this loads the LaunchAgent `so.marfa.connector-host`; on Linux it
enables the systemd user unit `marfa-connector-host.service` and prints the
`loginctl enable-linger` command that keeps it running while you're logged
out. The service runs `current/bin/marfa-connector-host`, so a later update
does not rewrite the service file. `install` sets up a service only from an
installed release; from any other copy it refuses and names `--no-service`.
With `--no-service`, it installs no service, and you run
`marfa-connector-host run` under your own supervisor. After `run` installs an
update it exits with code `75`, so have your supervisor restart it on that
code to start the new release.
Installing again with a new link replaces the host's identity and deletes
every connector's key and code. `"updates": false` in `host.json` is kept.
While a `run` the service doesn't own uses the host's folder, `install`
and `uninstall` refuse with "Stop the running host first"; the service's own
`run` they stop themselves. Either one waits for that `run` to stop before it
uses the link or removes anything. If it doesn't stop within 75 seconds,
nothing changes: the link stays unused, `install` starts the service again,
and the message says what to run once the `run` has stopped.

## Updates

Once a day the running host asks which release is newest, while it goes on
running your connectors. When a newer one exists, it checks that release's
archive, unpacks it beside the copy that is running, points `current` at it
and exits. The service starts the new one. `marfa-connector-host update` does
this when you run it.

A failed or stalled download, or a checksum that does not match, changes
nothing. Only one update puts a release in place at a time. The two newest
copies are kept, and so is the one that is running.

Turn the daily check off or on again with:

```sh
marfa-connector-host updates off
marfa-connector-host updates on
```

This writes `"updates"` in `host.json`, which the running host reads before
each check. `update` still works while the check is off.
`MARFA_CONNECTOR_HOST_NO_UPDATE=1` also turns it off, but only for a `run`
you start under your own supervisor: the service does not take it from your
shell.

## Status, logs and uninstall

```sh
marfa-connector-host status          # the host, and each connector it runs
marfa-connector-host logs [<plugin>] # the host's log, or one connector's
marfa-connector-host update          # install a newer release beside this one
marfa-connector-host updates off     # turn the daily update check off (or on)
marfa-connector-host uninstall       # removes the service, the command and every file
```

Uninstall removes the `~/.local/bin/marfa-connector-host` link when it points
at this install. After you uninstall, remove the host from your Marfa with
`marfa hosts remove <host>` so its connectors can run elsewhere.

## Files

The host keeps its files in `~/Library/Application Support/Marfa/Connector Host/`
on macOS, `$XDG_DATA_HOME/marfa/connector-host/` (by default
`~/.local/share/marfa/connector-host/`) on Linux, or the folder
`MARFA_CONNECTOR_HOST_HOME` names:

- `versions/<version>/`: one installed release. `current` points at the one
  the service runs.
- `versions/.stage-<process>-<random>/`: a release being unpacked, removed
  once it is in place or the update fails.
- `update.lock`: present while an update puts a release in place, so only one
  does.
- `host.json`: the Marfa address, the host's name and ID, and `"updates": false`
  when the daily check is off.
- `host.key`: the host's own key, mode 600.
- `run.lock`: the process ID of the `run` that uses the folder and the boot
  it started in, so only one does.
- `status.json`: what `status` prints, mode 600, present only while `run` is
  going.
- `connectors/<plugin>/key`: each connector's key, mode 600.
- `connectors/<plugin>/minted`: the version of the connector that its key was
  minted for.
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
- Once a day, unless the check is off: `https://github.com/withmarfa/plugins/releases/latest`,
  to learn the newest release's version, and, only when it is newer, that
  release's archive for this machine and its `checksums.txt`. These requests
  carry no key and no name of the host, your Marfa or its connectors. Turn the
  check off with `marfa-connector-host updates off`.
- When a connector fails before it registers, the host registers it with the
  connector's own key and reports one failed run, so you see the failure in
  Marfa.

## What a connector can do

Each connector runs in a process of its own under Node's permission model: it
can read only its own code file and reach the network. It can't write files,
start child processes or workers, or load native add-ons. It gets only
`MARFA_API_URL`, `MARFA_API_KEY`, `PATH`, `HOME`, the locale and time zone,
and the `OTEL_*` and `MARFA_OTEL_*` settings when the host has `OTEL_EXPORTER_OTLP_ENDPOINT` set.

Node doesn't treat its permission model as a security boundary against code
written to escape it. For example, it doesn't stop a connector from sending
signals to other processes of the same user. The permission model guards
against a faulty connector, not a hostile one, so install only plugins you
trust. That's why installing a plugin with a connector needs the
`connectors.manage` permission.
