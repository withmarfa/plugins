#!/usr/bin/env bash
# What .github/workflows/follow-node.yml decides, kept here so a test can pin it.
#
#   scripts/follow-node.sh decide current=<version> versions=<versions> open=<count>
#
# decide prints `bump <version>`, or `skip: <reason>` where the host stays on
# the Node release it carries. The arguments:
#   current   the version in host/node.json
#   versions  the releases nodejs.org lists, separated by spaces or newlines,
#             each with or without a leading v
#   open      how many open pull requests change host/node.json
#
# It proposes the newest release of the same major version as `current` that
# is newer than it, and never another major version or a pre-release: a new
# major version is a choice made by hand.
set -euo pipefail

die() {
  echo "follow-node.sh: $*" >&2
  exit 1
}

semver='^[0-9]+\.[0-9]+\.[0-9]+$'

decide() {
  local current="" versions="" open="" arg
  for arg in "$@"; do
    case "${arg}" in
      current=*) current="${arg#current=}" ;;
      versions=*) versions="${arg#versions=}" ;;
      open=*) open="${arg#open=}" ;;
      *) die "'${arg}' is not an argument" ;;
    esac
  done
  [[ "${current}" =~ ${semver} ]] || die "'${current}' is not an exact version"
  [[ "${open}" =~ ^[0-9]+$ ]] || die "'${open}' is not a count"
  local major="${current%%.*}" newest="${current}" version
  for version in ${versions}; do
    version="${version#v}"
    # A pre-release or any other form is no release of this line.
    [[ "${version}" =~ ${semver} && "${version%%.*}" == "${major}" ]] || continue
    if [[ "$(printf '%s\n%s\n' "${newest}" "${version}" | sort -V | tail -n 1)" == "${version}" ]]; then
      newest="${version}"
    fi
  done
  if [[ "${newest}" == "${current}" ]]; then
    echo "skip: the host carries Node ${current}, the newest ${major}.x release"
  elif ((open > 0)); then
    echo "skip: a pull request that moves the Node pin is open"
  else
    echo "bump ${newest}"
  fi
}

case "${1:-}" in
  decide)
    shift
    decide "$@"
    ;;
  *)
    echo "usage: scripts/follow-node.sh decide current=.. versions=.. open=.." >&2
    exit 2
    ;;
esac
