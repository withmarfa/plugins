#!/usr/bin/env bash
# Refuses a change to the index that touches a path other than the ones given.
# The workflows that apply a patch from a job that ran code fetched from the
# network call it once the patch is applied and staged, before anything is
# committed.
#
#   scripts/only-staged-paths.sh <path>...
#
# The staged paths are read NUL-separated, so a path that holds a newline is
# one path and is compared as it is, byte for byte, with each allowed path. A
# rename is two paths, the old and the new, since git is not asked to detect
# one. It fails when nothing is staged, or when any staged path is not one of
# the given paths, and names each such path in a form that holds no newline.
set -euo pipefail

(($# > 0)) || {
  echo "only-staged-paths.sh: name the paths a change may touch" >&2
  exit 2
}

found=0
refused=()
while IFS= read -r -d '' path; do
  found=1
  allowed=false
  for ok in "$@"; do
    if [[ "${path}" == "${ok}" ]]; then
      allowed=true
      break
    fi
  done
  [[ "${allowed}" == true ]] || refused+=("${path}")
done < <(git diff --cached --name-only -z --no-renames)

if ((found == 0)); then
  echo "::error::The change stages no file."
  exit 1
fi
if ((${#refused[@]} > 0)); then
  echo "::error::The change touches paths it may not:"
  printf '%q\n' "${refused[@]}"
  exit 1
fi
