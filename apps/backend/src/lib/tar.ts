import { gzipSync } from "zlib";

/**
 * c15 P3 — minimal USTAR archive builder (stdlib only, no `archiver`/`jszip`
 * per the no-new-package rule). Sufficient for the vehicle deploy package:
 * a handful of small text files, regular files only, paths < 100 chars.
 */

export interface TarEntry {
  /** Relative path inside the archive, e.g. "amr-01/r2-bridge.env". */
  name: string;
  content: string;
  /** POSIX mode, default 0644. Env files with tokens should use 0600. */
  mode?: number;
}

const BLOCK = 512;

function octal(value: number, length: number): Buffer {
  // Length includes the trailing NUL, per USTAR numeric field convention.
  const str = value.toString(8).padStart(length - 1, "0");
  return Buffer.from(`${str}\0`, "ascii");
}

function tarHeader(name: string, size: number, mode: number, mtime: Date): Buffer {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`tar entry name too long (>100 bytes): ${name}`);
  }

  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8"); // name
  octal(mode, 8).copy(header, 100); // mode
  octal(0, 8).copy(header, 108); // uid
  octal(0, 8).copy(header, 116); // gid
  octal(size, 12).copy(header, 124); // size
  octal(Math.floor(mtime.getTime() / 1000), 12).copy(header, 136); // mtime
  header.fill(" ", 148, 156); // chksum placeholder (spaces while summing)
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, 6, "ascii"); // magic
  header.write("00", 263, 2, "ascii"); // version
  header.write("rvep", 265, 4, "ascii"); // uname
  header.write("rvep", 297, 4, "ascii"); // gname

  let checksum = 0;
  for (const byte of header) checksum += byte;
  // chksum: 6 octal digits + NUL + space.
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

  return header;
}

/** Build an uncompressed tar archive from in-memory text entries. */
export function buildTar(entries: TarEntry[], mtime: Date = new Date()): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = Buffer.from(entry.content, "utf8");
    parts.push(tarHeader(entry.name, body.length, entry.mode ?? 0o644, mtime));
    parts.push(body);
    const remainder = body.length % BLOCK;
    if (remainder !== 0) parts.push(Buffer.alloc(BLOCK - remainder));
  }
  // End-of-archive: two zero blocks.
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

/** Build a .tar.gz from in-memory text entries. */
export function buildTarGz(entries: TarEntry[], mtime: Date = new Date()): Buffer {
  return gzipSync(buildTar(entries, mtime));
}
