#!/usr/bin/env bash
# Fetches the `marfa-server` and the `marfa` command line of the marfa release
# whose tag names the commit in scripts/monorepo.commit, from that release's
# archive, into vendor/marfa-server and vendor/marfa.
# `scripts/monorepo.sh hooks` instead builds that commit's server with test
# hooks, which a release is built without, into vendor/marfa-server-hooks.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(tr -d '[:space:]' <"${root}/scripts/monorepo.commit")"
mode="${1:-release}"
case "${mode}" in
  release)
    dir="${root}/vendor/marfa-server"
    cli_dir="${root}/vendor/marfa"
    ;;
  hooks) dir="${root}/vendor/marfa-server-hooks" ;;
  *) echo "usage: scripts/monorepo.sh [hooks]" >&2; exit 2 ;;
esac

die() {
  echo "monorepo.sh: $*" >&2
  exit 1
}

held() {
  [[ -x "$1/$2" && "$(cat "$1/commit" 2>/dev/null || true)" == "${commit}" ]]
}

if [[ "${mode}" == hooks ]]; then
  held "${dir}" marfa-server && exit 0
else
  held "${dir}" marfa-server && held "${cli_dir}" marfa && exit 0
fi

if [[ "${mode}" == hooks ]]; then
  work="$(mktemp -d)"
  trap 'rm -rf "${work}"' EXIT
  git init --quiet "${work}/src"
  git -C "${work}/src" fetch --quiet --depth 1 https://github.com/withmarfa/marfa.git "${commit}"
  git -C "${work}/src" checkout --quiet FETCH_HEAD
  cargo build --release --locked --manifest-path "${work}/src/core/Cargo.toml" \
    --package marfa-server --features test-hooks --target-dir "${work}/target"
  rm -rf "${dir}"
  mkdir -p "${dir}"
  mv "${work}/target/release/marfa-server" "${dir}/marfa-server"
  echo "${commit}" >"${dir}/commit"
  echo "monorepo.sh: hooks ${commit}"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) platform=linux-x86_64 ;;
  Darwin-arm64) platform=darwin-arm64 ;;
  *) die "there is no release archive for $(uname -s) on $(uname -m)" ;;
esac

# A tag points at a commit directly, or through its own object, which
# ls-remote lists beside it as `<tag>^{}`.
tag="$(git ls-remote --tags https://github.com/withmarfa/marfa.git 'v*' |
  awk -v commit="${commit}" '$1 == commit { sub("refs/tags/", "", $2); sub(/\^\{\}$/, "", $2); print $2 }' |
  sort -V | tail -n 1)"
[[ -n "${tag}" ]] || die "no release tag of withmarfa/marfa names ${commit}"

archive="marfa-${tag#v}-${platform}.tar.gz"
checksums="marfa-${tag#v}-checksums.txt"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

base="https://github.com/withmarfa/marfa/releases/download/${tag}"
curl --fail --silent --show-error --location --retry 3 --output "${work}/${archive}" "${base}/${archive}"
curl --fail --silent --show-error --location --retry 3 --output "${work}/${checksums}" "${base}/${checksums}"

expected="$(awk -v name="${archive}" '$2 == name { print $1 }' "${work}/${checksums}")"
[[ -n "${expected}" ]] || die "${checksums} lists no ${archive}"
actual="$(shasum -a 256 "${work}/${archive}" | awk '{ print $1 }')"
[[ "${actual}" == "${expected}" ]] || die "${archive} has the checksum ${actual}, and ${checksums} gives ${expected}"

mkdir "${work}/unpacked"
tar -xzf "${work}/${archive}" -C "${work}/unpacked" marfa-server marfa
for pair in "${dir}:marfa-server" "${cli_dir}:marfa"; do
  target="${pair%%:*}"
  program="${pair##*:}"
  rm -rf "${target}"
  mkdir -p "${target}"
  mv "${work}/unpacked/${program}" "${target}/${program}"
  chmod +x "${target}/${program}"
  echo "${commit}" >"${target}/commit"
done
echo "monorepo.sh: ${tag} ${platform}"
