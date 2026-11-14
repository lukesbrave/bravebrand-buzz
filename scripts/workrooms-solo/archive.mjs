// Joins a backup's files into one tar stream and splits one back out, in the
// plain "ustar" layout every tar tool reads. Written here so the kit needs
// nothing installed and never hands a backup's contents to another program.
import {
  closeSync,
  createReadStream,
  openSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { byteReader } from "./age.mjs";

const BLOCK = 512;

function header(name, size) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  block.write("0000600\0", 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  if (size < 8 ** 11)
    block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  else {
    // Sizes past 8 GB do not fit the octal field; tar tools read this form.
    block[124] = 0x80;
    block.writeBigUInt64BE(BigInt(size), 128);
  }
  block.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
    136,
    "latin1",
  );
  block.write("        ", 148, "latin1");
  block.write("0", 156, "latin1");
  block.write("ustar\x0000", 257, "latin1");
  block.write(
    `${checksum(block).toString(8).padStart(6, "0")}\0 `,
    148,
    "latin1",
  );
  return block;
}

/** A header's checksum counts its own field as spaces. */
function checksum(block) {
  let sum = 8 * 32;
  for (let at = 0; at < BLOCK; at++)
    if (at < 148 || at >= 156) sum += block[at];
  return sum;
}

/** Yields one tar stream holding the named files of a folder. */
export async function* pack(folder, names) {
  for (const name of names) {
    const file = join(folder, name);
    const size = statSync(file).size;
    yield header(name, size);
    let read = 0;
    for await (const piece of createReadStream(file)) {
      read += piece.length;
      yield piece;
    }
    if (read !== size) throw new Error(`${name} changed while it was read.`);
    if (size % BLOCK) yield Buffer.alloc(BLOCK - (size % BLOCK));
  }
  yield Buffer.alloc(2 * BLOCK);
}

/**
 * Writes the files of a tar stream into a folder and returns their names.
 * Only plain files named in `allowed` are accepted, each once, so a stream
 * can never write outside the folder.
 */
export async function unpack(source, folder, allowed) {
  const input = byteReader(source);
  const short = () => new Error("The backup's contents are incomplete.");
  const found = [];
  for (;;) {
    const block = await input.take(BLOCK);
    if (block.length < BLOCK) throw short();
    if (block.every((byte) => byte === 0)) return found;
    const name = block.toString("utf8", 0, block.indexOf(0));
    const stated = Number.parseInt(block.toString("latin1", 148, 156), 8);
    const kind = block[156];
    if (
      stated !== checksum(block) ||
      (kind !== 48 && kind !== 0) ||
      !allowed.includes(name) ||
      found.includes(name)
    )
      throw new Error("The backup's contents are not what this kit made.");
    const size =
      block[124] & 0x80
        ? Number(block.readBigUInt64BE(128))
        : Number.parseInt(block.toString("latin1", 124, 136), 8);
    const file = openSync(join(folder, name), "w", 0o600);
    try {
      for (let left = size; left > 0; ) {
        const piece = await input.take(Math.min(left, 1 << 20));
        if (piece.length === 0) throw short();
        writeSync(file, piece);
        left -= piece.length;
      }
    } finally {
      closeSync(file);
    }
    await input.take((BLOCK - (size % BLOCK)) % BLOCK);
    found.push(name);
  }
}
