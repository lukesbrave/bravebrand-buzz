import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { decrypt, encrypt, newKeyPair, recipientFor } from "./age.mjs";
import { pack, unpack } from "./archive.mjs";
import { PARTS, seal, send, unseal } from "./vault.mjs";

const scratch = mkdtempSync(join(tmpdir(), "workrooms-backups-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const folder = (name) => {
  const path = join(scratch, name);
  mkdirSync(path, { recursive: true });
  return path;
};
const from = async function* (...buffers) {
  yield* buffers;
};
const collect = async (stream) => {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
};
/** The error code a stream ends with, or "opened". */
const outcome = (secret, data) =>
  collect(decrypt(secret, from(data))).then(
    () => "opened",
    (error) => error.code,
  );

// A key made for this test only, and a file the reference age library
// (age-encryption 0.3.1) encrypted for it.
const REFERENCE = {
  secret:
    "AGE-SECRET-KEY-1Y392Q80C77Z3R8H8FYUD32FWZP4224DGQRLALA8DULCKL05ZEEJQAP5KW6",
  recipient: "age1e44pq6td3skethl4h5wtqh9rllwp2gatmwc7mk9j6hdy47ytkdgqvp5rpx",
  sealed:
    "YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSAvcDRPWnUrUEJ5VjFKdk90WHpMSFRKN2xmRmFLd2lOU1JuYXExRHBiYWxjCnlWNXYwTlVGTkJJYjJPUkJNUjU0NU5uVkh5NGN4Sk93YnUzUVpERVFPSUkKLS0tIGlOdEVRL2hFMDFyL2FRSG8zM3E5bVhIbU5XMWhHbjh1U1NCd0tSZDZzRDgK8FvaQbLCl4eIUmiZB0k/mfEl0HGfYeu0VHCjfdV7LXxzNH8qqt4915HOcXqpfJiNF6yGwsR3pUCcQ7dEuI6uNqsTpw==",
};

describe("backup keys", () => {
  it("derives the public half the reference library does", () => {
    expect(recipientFor(REFERENCE.secret)).toBe(REFERENCE.recipient);
  });

  it("makes a pair whose halves belong together", () => {
    const pair = newKeyPair();
    expect(pair.secret).toMatch(/^AGE-SECRET-KEY-1[A-Z0-9]{58}$/);
    expect(pair.recipient).toMatch(/^age1[a-z0-9]{58}$/);
    expect(recipientFor(pair.secret)).toBe(pair.recipient);
    expect(newKeyPair().secret).not.toBe(pair.secret);
  });

  it("recognises nothing else as a backup key", () => {
    for (const text of [
      "",
      "hello",
      REFERENCE.recipient,
      REFERENCE.secret.toLowerCase(),
      `${REFERENCE.secret.slice(0, -1)}7`,
    ])
      expect(recipientFor(text)).toBeUndefined();
  });
});

describe("encrypted files", () => {
  const pair = newKeyPair();

  it("opens a file the reference library made", async () => {
    const plain = await collect(
      decrypt(REFERENCE.secret, from(Buffer.from(REFERENCE.sealed, "base64"))),
    );
    expect(plain.toString()).toBe("Made by the reference age library.\n");
  });

  it("returns exactly what went in, at every size around a chunk", async () => {
    for (const size of [0, 1, 65_535, 65_536, 65_537, 200_000]) {
      const plain = randomBytes(size);
      // Fed in uneven pieces, as a file stream would.
      const sealed = await collect(
        encrypt(pair.recipient, from(plain.subarray(0, 7), plain.subarray(7))),
      );
      expect(sealed.includes(plain.subarray(0, 32)) && size >= 32).toBe(false);
      const opened = await collect(
        decrypt(
          pair.secret,
          from(sealed.subarray(0, 100), sealed.subarray(100)),
        ),
      );
      expect(opened.equals(plain)).toBe(true);
    }
  });

  it("refuses a different key", async () => {
    const sealed = await collect(
      encrypt(pair.recipient, from(randomBytes(900))),
    );
    expect(await outcome(newKeyPair().secret, sealed)).toBe("WRONG_KEY");
    expect(await outcome("not a key", sealed)).toBe("NOT_A_KEY");
  });

  it("refuses a file that was changed, cut short or added to", async () => {
    const sealed = await collect(
      encrypt(pair.recipient, from(randomBytes(200_000))),
    );
    const start = sealed.indexOf("\n", sealed.indexOf("\n---") + 1) + 1 + 16;
    const changed = (at) => {
      const copy = Buffer.from(sealed);
      copy[at] ^= 1;
      return copy;
    };
    // One changed bit anywhere in the contents: first, middle and last chunk.
    for (const at of [start, start + 70_000, sealed.length - 1])
      expect(await outcome(pair.secret, changed(at))).toBe("DAMAGED");
    // The header: the wrapped key, and the check value over the header.
    expect(await outcome(pair.secret, changed(80))).not.toBe("opened");
    expect(await outcome(pair.secret, changed(start - 30))).not.toBe("opened");
    // Cut at a chunk boundary, cut mid-chunk, and extended.
    for (const cut of [start + 65_552, sealed.length - 5, start])
      expect(await outcome(pair.secret, sealed.subarray(0, cut))).toBe(
        "DAMAGED",
      );
    expect(
      await outcome(pair.secret, Buffer.concat([sealed, Buffer.from("x")])),
    ).toBe("DAMAGED");
    expect(await outcome(pair.secret, Buffer.from("just some text\n"))).toBe(
      "NOT_AGE",
    );
  });
});

describe("a backup as one encrypted file", () => {
  const pair = newKeyPair();
  const original = folder("original");
  const sizes = [40, 900, 3_000_000, 512, 0];
  for (const [at, name] of PARTS.entries())
    writeFileSync(
      join(original, name),
      name === "settings.env"
        ? `BUZZ_RELAY_PRIVATE_KEY=${"ab".repeat(32)}\n`
        : randomBytes(sizes[at]),
    );
  const file = join(scratch, "Workrooms backup 2026-11-14 0900.tar.age");

  it("comes back byte for byte with the backup key", async () => {
    await seal(original, pair.recipient, file);
    expect(readFileSync(file).includes("BUZZ_RELAY_PRIVATE_KEY")).toBe(false);
    const opened = folder("opened");
    await unseal(file, pair.secret, opened);
    expect(readdirSync(opened).sort()).toEqual([...PARTS].sort());
    for (const name of PARTS)
      expect(
        readFileSync(join(opened, name)).equals(
          readFileSync(join(original, name)),
        ),
      ).toBe(true);
  });

  it("does not open with another key or after a change", async () => {
    await expect(
      unseal(file, newKeyPair().secret, folder("wrong")),
    ).rejects.toMatchObject({ code: "WRONG_KEY" });
    const changed = Buffer.from(readFileSync(file));
    changed[changed.length - 2_000] ^= 1;
    writeFileSync(join(scratch, "changed.tar.age"), changed);
    await expect(
      unseal(join(scratch, "changed.tar.age"), pair.secret, folder("changed")),
    ).rejects.toMatchObject({ code: "DAMAGED" });
  });

  it("accepts only the files a backup is made of", async () => {
    const odd = folder("odd");
    writeFileSync(join(odd, "surprise.sh"), "echo");
    await expect(
      unpack(pack(odd, ["surprise.sh"]), folder("out"), PARTS),
    ).rejects.toThrow("not what this kit made");
    expect(readdirSync(join(scratch, "out"))).toEqual([]);
    await expect(
      unpack(
        pack(original, ["backup.json", "backup.json"]),
        folder("twice"),
        PARTS,
      ),
    ).rejects.toThrow("not what this kit made");
  });
});

describe("sending copies to a folder", () => {
  const made = folder("made");
  const backup = (stamp) => {
    const file = join(made, `Workrooms backup 2026-11-${stamp}.tar.age`);
    writeFileSync(file, stamp);
    return file;
  };

  it("keeps the newest and leaves other files alone", async () => {
    const destination = folder("cloud");
    writeFileSync(join(destination, "holiday.jpg"), "theirs");
    const offsite = { folder: destination, keep: 2 };
    for (const stamp of ["01 0900", "08 0900", "15 0900"])
      expect(await send(backup(stamp), offsite)).toEqual({ folder: true });
    expect(readdirSync(destination).sort()).toEqual([
      "Workrooms backup 2026-11-08 0900.tar.age",
      "Workrooms backup 2026-11-15 0900.tar.age",
      "holiday.jpg",
    ]);
  });

  it("reports a missing folder and does not create it", async () => {
    const missing = join(scratch, "unplugged-drive");
    const sent = await send(backup("22 0900"), { folder: missing });
    expect(sent.folder).toContain("missing");
    expect(existsSync(missing)).toBe(false);
  });
});
