#!/bin/sh
# Installs the Marfa connector host from one release and links this machine.
#
# The version and the repository are written in when the release is built, so
# a script fetched from releases/latest never downloads another tag's files.
# MARFA_CONNECTOR_HOST_RELEASE_BASE replaces the download address. Tests set
# it. The script still fetches only this release's archive and checksums.txt,
# and it installs nothing until the checksum matches.
set -eu

VERSION=@VERSION@
REPOSITORY=@REPOSITORY@
BASE="${MARFA_CONNECTOR_HOST_RELEASE_BASE:-https://github.com/${REPOSITORY}/releases/download/v${VERSION}}"

fail() {
  printf '%s\n' "marfa-connector-host: $1" >&2
  exit 1
}

if [ $# -lt 1 ] || [ -z "$1" ]; then
  fail "Give the one-time link from \`marfa hosts add\`. The command is: curl -fsSL https://github.com/${REPOSITORY}/releases/latest/download/install-host.sh | sh -s -- '<link>'"
fi
link=$1

if ! command -v curl >/dev/null 2>&1; then
  fail "curl is not installed."
fi

sys=$(uname -s)
mach=$(uname -m)
case "$sys:$mach" in
  Darwin:arm64) platform=darwin-arm64 ;;
  Darwin:x86_64) platform=darwin-x64 ;;
  Linux:x86_64) platform=linux-x64 ;;
  Linux:aarch64 | Linux:arm64) platform=linux-arm64 ;;
  *) fail "This system (${sys} ${mach}) has no connector host build." ;;
esac

archive="marfa-connector-host-${VERSION}-${platform}.tar.gz"

if [ -n "${MARFA_CONNECTOR_HOST_HOME:-}" ]; then
  root=$MARFA_CONNECTOR_HOST_HOME
elif [ "$sys" = Darwin ]; then
  root="$HOME/Library/Application Support/Marfa/Connector Host"
else
  data=${XDG_DATA_HOME:-}
  case $data in
    /*) root="$data/marfa/connector-host" ;;
    *) root="$HOME/.local/share/marfa/connector-host" ;;
  esac
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if ! curl -fsSL "$BASE/$archive" -o "$work/$archive"; then
  fail "Could not download ${archive}. Nothing was installed."
fi
if ! curl -fsSL "$BASE/checksums.txt" -o "$work/checksums.txt"; then
  fail "Could not download checksums.txt. Nothing was installed."
fi

wanted=$(awk -v name="$archive" '$2 == name { print $1; exit }' "$work/checksums.txt")
if [ -z "$wanted" ]; then
  fail "checksums.txt does not list ${archive}. Nothing was installed."
fi
if command -v shasum >/dev/null 2>&1; then
  found=$(shasum -a 256 "$work/$archive" | awk '{ print $1 }')
elif command -v sha256sum >/dev/null 2>&1; then
  found=$(sha256sum "$work/$archive" | awk '{ print $1 }')
else
  fail "Neither shasum nor sha256sum is installed. Nothing was installed."
fi
if [ "$found" != "$wanted" ]; then
  fail "The checksum of ${archive} does not match. Nothing was installed."
fi

dest="$root/versions/$VERSION"
stage="$root/versions/${VERSION}.partial"
rm -rf "$stage"
mkdir -p "$stage"
if ! tar -xzf "$work/$archive" -C "$stage" --strip-components=1; then
  rm -rf "$stage"
  fail "Could not unpack ${archive}. Nothing was installed."
fi
rm -rf "$dest"
mv "$stage" "$dest"

# `ln -sfn` replaces a symlink. `mv` onto `current` would follow it when it
# already points at a directory, and the new link would land inside the old
# version.
ln -sfn "versions/$VERSION" "$root/current"
mkdir -p "$HOME/.local/bin"
ln -sfn "$root/current/bin/marfa-connector-host" "$HOME/.local/bin/marfa-connector-host"

rm -rf "$work"
trap - EXIT
exec "$HOME/.local/bin/marfa-connector-host" install "$link"
