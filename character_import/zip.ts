/**
 * Minimal, dependency-free ZIP reader for character archives.
 *
 * MMD model archives are usually created on Chinese or Japanese Windows
 * without the UTF-8 flag, so entry names are GBK or Shift-JIS bytes. Generic
 * extractors (Explorer, PowerShell's Expand-Archive) turn those into mojibake,
 * which then breaks the PMX's texture references. This reader decodes names
 * with the encoding that yields valid text and refuses unsafe paths.
 */
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

export interface ZipEntry {
  name: string;
  /** Raw name bytes, for diagnostics. */
  encoding: string;
  compressedSize: number;
  size: number;
  method: number;
  offset: number;
  directory: boolean;
}

const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 5000;

/**
 * Pick ONE legacy encoding for the whole archive. Guessing per entry is wrong:
 * short GBK names are often also valid UTF-8 (伞 = C9 A1 decodes as "ɡ"), so
 * the archive-wide encoding is the first that decodes every unflagged name.
 */
function detectArchiveEncoding(rawNames: Buffer[]): string {
  const nonAscii = rawNames.filter((bytes) => bytes.some((b) => b >= 0x80));
  if (nonAscii.length === 0) return "ascii";
  for (const encoding of ["utf-8", "gbk", "shift_jis", "big5"]) {
    const decoder = new TextDecoder(encoding, { fatal: true });
    try {
      for (const bytes of nonAscii) decoder.decode(bytes);
      return encoding;
    } catch {
      /* try the next one */
    }
  }
  return "gbk";
}

export class ZipArchive {
  private constructor(
    private readonly buffer: Buffer,
    readonly entries: ZipEntry[]
  ) {}

  static async open(file: string): Promise<ZipArchive> {
    const buffer = await fs.readFile(file);
    // End of central directory: scan back over a possible comment.
    let eocd = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
      if (buffer.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("Not a ZIP archive (no end-of-central-directory record).");
    const count = buffer.readUInt16LE(eocd + 10);
    let pointer = buffer.readUInt32LE(eocd + 16);
    if (count > MAX_ENTRIES) throw new Error(`ZIP has too many entries (${count}).`);
    const raw: Array<Omit<ZipEntry, "name" | "encoding" | "directory"> & { rawName: Buffer; utf8: boolean }> = [];
    for (let i = 0; i < count; i += 1) {
      if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("Corrupt ZIP central directory.");
      const flags = buffer.readUInt16LE(pointer + 8);
      const method = buffer.readUInt16LE(pointer + 10);
      const compressedSize = buffer.readUInt32LE(pointer + 20);
      const size = buffer.readUInt32LE(pointer + 24);
      const nameLength = buffer.readUInt16LE(pointer + 28);
      const extraLength = buffer.readUInt16LE(pointer + 30);
      const commentLength = buffer.readUInt16LE(pointer + 32);
      const offset = buffer.readUInt32LE(pointer + 42);
      const rawName = buffer.subarray(pointer + 46, pointer + 46 + nameLength);
      raw.push({ rawName, utf8: (flags & 0x800) !== 0, compressedSize, size, method, offset });
      pointer += 46 + nameLength + extraLength + commentLength;
    }
    const legacy = detectArchiveEncoding(raw.filter((item) => !item.utf8).map((item) => item.rawName));
    const entries: ZipEntry[] = raw.map(({ rawName, utf8, ...rest }) => {
      const encoding = utf8 ? "utf-8" : legacy;
      const name = new TextDecoder(encoding === "ascii" ? "latin1" : encoding).decode(rawName).replace(/\\/g, "/");
      return { ...rest, name, encoding, directory: name.endsWith("/") };
    });
    return new ZipArchive(buffer, entries);
  }

  read(entry: ZipEntry): Buffer {
    if (entry.size > MAX_ENTRY_BYTES) throw new Error(`ZIP entry too large: ${entry.name}`);
    const header = entry.offset;
    if (this.buffer.readUInt32LE(header) !== 0x04034b50) throw new Error(`Corrupt local header for ${entry.name}`);
    const nameLength = this.buffer.readUInt16LE(header + 26);
    const extraLength = this.buffer.readUInt16LE(header + 28);
    const start = header + 30 + nameLength + extraLength;
    const data = this.buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  }

  /** Extract every entry below `destination`, rejecting path traversal. */
  async extractAll(destination: string): Promise<string[]> {
    const root = path.resolve(destination);
    let total = 0;
    const written: string[] = [];
    for (const entry of this.entries) {
      const relative = entry.name.replace(/^\/+/, "");
      const target = path.resolve(root, relative);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error(`Unsafe path in ZIP: ${entry.name}`);
      }
      if (entry.directory) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }
      total += entry.size;
      if (total > MAX_TOTAL_BYTES) throw new Error("ZIP expands beyond the 2 GB safety limit.");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, this.read(entry));
      written.push(relative);
    }
    return written;
  }
}
