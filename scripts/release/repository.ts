/**
 * The repository a release is published to. A connector's code address and
 * the install script are written from it, and the build writes it into the
 * host's bundle, which updates from it, so a fork's release updates from the
 * fork. `GH_REPO` overrides it where `gh` has no checkout, and must be
 * `owner/name`.
 */
const ownerAndName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const defaultRepository = "withmarfa/plugins";

export function repository(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env["GH_REPO"];
  if (chosen === undefined || chosen === "") return defaultRepository;
  if (!ownerAndName.test(chosen)) {
    throw new Error(`GH_REPO must be owner/name, and it is ${chosen}`);
  }
  return chosen;
}

/** The address of one file of the release `v<version>`. */
export function downloadUrl(
  repo: string,
  version: string,
  file: string,
): string {
  return `https://github.com/${repo}/releases/download/v${version}/${file}`;
}
