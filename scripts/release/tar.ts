/**
 * A ustar archive, gzipped, that two builds of the same files share byte for
 * byte. The system tar on macOS cannot sort names, and gzip stores a
 * modification time, so an archive it writes changes between machines.
 */
import { crc32, deflateRawSync } from "node:zlib";

export interface TarFile {
  /** Path inside the archive, with `/` separators and no leading slash. */
  path: string;
  bytes: Buffer;
  /** Permission bits, such as `0o755` for a program. */
  mode: number;
}

const block = 512;

function octal(value: number, width: number): Buffer {
  const field = Buffer.alloc(width);
  const text = value.toString(8).padStart(width - 1, "0");
  if (text.length > width - 1) {
    throw new Error(
      `${String(value)} does not fit in a tar field of ${String(width)} bytes`,
    );
  }
  field.write(text, "ascii");
  return field;
}

function header(
  name: string,
  mode: number,
  size: number,
  type: string,
): Buffer {
  if (name.length > 100) {
    throw new Error(`${name} is longer than a ustar name`);
  }
  const bytes = Buffer.alloc(block);
  bytes.write(name, "ascii");
  octal(mode, 8).copy(bytes, 100);
  octal(0, 8).copy(bytes, 108);
  octal(0, 8).copy(bytes, 116);
  octal(size, 12).copy(bytes, 124);
  octal(0, 12).copy(bytes, 136);
  bytes.fill(0x20, 148, 156);
  bytes.write(type, 156, "ascii");
  bytes.write("ustar\0", 257, "ascii");
  bytes.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of bytes) sum += byte;
  bytes.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
  bytes[154] = 0;
  bytes[155] = 0x20;
  return bytes;
}

function parents(path: string): string[] {
  const parts = path.split("/");
  const found: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    found.push(`${parts.slice(0, index).join("/")}/`);
  }
  return found;
}

/**
 * The gzip of a ustar archive of `files`: names sorted, modification time 0,
 * and no owner or group name. Directory entries are added for every parent.
 */
export function tarGz(files: readonly TarFile[]): Buffer {
  const directories = new Set<string>();
  for (const file of files) {
    if (file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error(`${file.path} is not a path inside the archive`);
    }
    for (const directory of parents(file.path)) directories.add(directory);
  }
  const entries = [
    ...[...directories].map((path) => ({
      path,
      bytes: Buffer.alloc(0),
      mode: 0o755,
      type: "5",
    })),
    ...files.map((file) => ({ ...file, type: "0" })),
  ].sort((left, right) => (left.path < right.path ? -1 : 1));
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(header(entry.path, entry.mode, entry.bytes.length, entry.type));
    if (entry.bytes.length > 0) {
      chunks.push(entry.bytes);
      const extra = entry.bytes.length % block;
      if (extra !== 0) chunks.push(Buffer.alloc(block - extra));
    }
  }
  chunks.push(Buffer.alloc(block * 2));
  return gzip(Buffer.concat(chunks));
}

function gzip(body: Buffer): Buffer {
  const compressed = deflateRawSync(body, { level: 9 });
  const prefix = Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255]);
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(body) >>> 0, 0);
  trailer.writeUInt32LE(body.length >>> 0, 4);
  return Buffer.concat([prefix, compressed, trailer]);
}
