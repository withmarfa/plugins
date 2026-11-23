/**
 * The flags a connector's bundle is run under, by the host, the proof and the
 * CI job alike, so they cannot disagree on what a connector is allowed.
 *
 * The Node permission model denies everything the flags do not grant: no
 * write to the file system, no child process, no worker, no native add-on. A
 * bundle reads only itself. `--allow-net` is needed because the permission
 * model denies the network by default (Node 25 and later). No connector
 * starts a worker, and `--allow-worker` is never given: a worker can be
 * started with `execArgv` that grant it every permission, which would end
 * the sandbox.
 *
 * `maxHeapMb` caps the old generation of every connector's heap, since
 * nothing else bounds what a connector holds once it parses in the one
 * thread. Buffers live outside that heap and are bounded by the limits on
 * what a connector downloads.
 *
 * Node resolves the real path of its entry before it reads it, and that
 * reads every folder on the way: a bundle reached through a link (macOS's
 * `/var` and `/tmp` are links) is refused as `ERR_ACCESS_DENIED` on the link.
 * The bundle named in the flags and run must be a real path.
 */
export const maxHeapMb = 512;

export function permissionFlags(bundle: string): string[] {
  return [
    "--permission",
    `--allow-fs-read=${bundle}`,
    "--allow-net",
    `--max-old-space-size=${String(maxHeapMb)}`,
  ];
}
