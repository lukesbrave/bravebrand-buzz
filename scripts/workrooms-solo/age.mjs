// Encrypts and opens files in the age format (age-encryption.org/v1, one
// X25519 recipient), so a backup made here opens with the free age tool and
// does not depend on this kit. Only the file layout is written here: the
// cryptography is Node's own (X25519, HKDF-SHA-256, ChaCha20-Poly1305), which
// keeps the kit free of installed packages.
//
// A backup key is a pair. The public half (age1…) encrypts and is safe to
// keep on the computer. The secret half (AGE-SECRET-KEY-1…) opens backups.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { bech32Decode, bech32Encode } from "./common.mjs";

const VERSION = "age-encryption.org/v1";
const CHUNK = 64 * 1024;
const TAG = 16;
// The fixed wrappers Node needs around a raw 32-byte X25519 key.
const SECRET_WRAPPER = Buffer.from("302e020100300506032b656e04220420", "hex");
const PUBLIC_WRAPPER = Buffer.from("302a300506032b656e032100", "hex");

const secretKey = (bytes) =>
  createPrivateKey({
    key: Buffer.concat([SECRET_WRAPPER, bytes]),
    format: "der",
    type: "pkcs8",
  });
const publicKey = (bytes) =>
  createPublicKey({
    key: Buffer.concat([PUBLIC_WRAPPER, bytes]),
    format: "der",
    type: "spki",
  });
const publicBytes = (secret) =>
  createPublicKey(secret).export({ format: "der", type: "spki" }).subarray(-32);
const derive = (key, salt, info) =>
  Buffer.from(hkdfSync("sha256", key, salt, info, 32));
const base64 = (bytes) => bytes.toString("base64").replace(/=+$/, "");
/** The bytes of unpadded base64, or undefined if it is not written exactly. */
function unbase64(text) {
  const bytes = Buffer.from(text, "base64");
  return base64(bytes) === text ? bytes : undefined;
}
function seal(key, nonce, data) {
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: TAG,
  });
  return Buffer.concat([
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
/** Throws when the data was not sealed with this key and nonce. */
function unseal(key, nonce, data) {
  const cipher = createDecipheriv("chacha20-poly1305", key, nonce, {
    authTagLength: TAG,
  });
  cipher.setAuthTag(data.subarray(-TAG));
  return Buffer.concat([cipher.update(data.subarray(0, -TAG)), cipher.final()]);
}
/** Each chunk's nonce is its number, and a final byte marking the last one. */
function chunkNonce(count, last) {
  const nonce = Buffer.alloc(12);
  nonce.writeUIntBE(count, 5, 6);
  nonce[11] = last ? 1 : 0;
  return nonce;
}
const wrappingKey = (shared, sender, recipient) =>
  derive(shared, Buffer.concat([sender, recipient]), `${VERSION}/X25519`);
const problem = (code, message) => Object.assign(new Error(message), { code });

function secretBytes(text) {
  const hex =
    text === text.toUpperCase()
      ? bech32Decode("age-secret-key-", text.toLowerCase())
      : undefined;
  return hex ? Buffer.from(hex, "hex") : undefined;
}

/** The public half of a secret half, or undefined if the text is not one. */
export function recipientFor(secret) {
  const bytes = secretBytes(secret);
  return bytes
    ? bech32Encode("age", publicBytes(secretKey(bytes)).toString("hex"))
    : undefined;
}

export function newKeyPair() {
  const secret = bech32Encode(
    "age-secret-key-",
    randomBytes(32).toString("hex"),
  ).toUpperCase();
  return { secret, recipient: recipientFor(secret) };
}

/** Reads exact amounts from a stream of buffers of any sizes. */
export function byteReader(source) {
  const stream = source[Symbol.asyncIterator]();
  let held = Buffer.alloc(0);
  let ended = false;
  async function fill(size) {
    const parts = [held];
    let length = held.length;
    while (length < size && !ended) {
      const { value, done } = await stream.next();
      if (done) ended = true;
      else {
        parts.push(value);
        length += value.length;
      }
    }
    held = Buffer.concat(parts);
  }
  return {
    /** The next `size` bytes, or fewer only where the stream ends. */
    async take(size) {
      await fill(size);
      const taken = held.subarray(0, size);
      held = held.subarray(size);
      return taken;
    },
    /** The text up to the next line break. */
    async line() {
      for (;;) {
        const end = held.indexOf(10);
        if (end >= 0) {
          const text = held.toString("latin1", 0, end);
          held = held.subarray(end + 1);
          return text;
        }
        if (ended || held.length > 4096)
          throw problem("NOT_AGE", "This is not an encrypted backup.");
        await fill(held.length + 1);
      }
    },
  };
}

/** Yields the encrypted form of a stream of buffers, for one public half. */
export async function* encrypt(recipient, source) {
  const hex = bech32Decode("age", recipient);
  if (!hex)
    throw problem("NOT_A_KEY", "That is not a backup key's public half.");
  const to = Buffer.from(hex, "hex");
  // The file has its own random key, wrapped so only the recipient's secret
  // half can recover it.
  const fileKey = randomBytes(16);
  const sender = secretKey(randomBytes(32));
  const senderShare = publicBytes(sender);
  const shared = diffieHellman({
    privateKey: sender,
    publicKey: publicKey(to),
  });
  const wrapped = seal(
    wrappingKey(shared, senderShare, to),
    Buffer.alloc(12),
    fileKey,
  );
  const header = `${VERSION}\n-> X25519 ${base64(senderShare)}\n${base64(wrapped)}\n---`;
  const mac = createHmac("sha256", derive(fileKey, Buffer.alloc(0), "header"))
    .update(header)
    .digest();
  yield Buffer.from(`${header} ${base64(mac)}\n`);
  const nonce = randomBytes(16);
  yield nonce;
  const payloadKey = derive(fileKey, nonce, "payload");
  const input = byteReader(source);
  let chunk = await input.take(CHUNK);
  for (let count = 0; ; count++) {
    const next = await input.take(CHUNK);
    const last = next.length === 0;
    yield seal(payloadKey, chunkNonce(count, last), chunk);
    if (last) return;
    chunk = next;
  }
}

/**
 * Yields the contents of an encrypted stream, given the secret half. Throws
 * with code WRONG_KEY when the key is not the one it was encrypted for, and
 * DAMAGED when the file was changed or cut short. Contents are yielded as
 * they are verified, so a caller keeps nothing from a stream that throws.
 */
export async function* decrypt(secret, source) {
  const bytes = secretBytes(secret);
  if (!bytes) throw problem("NOT_A_KEY", "That is not a backup key.");
  const mine = secretKey(bytes);
  const myShare = publicBytes(mine);
  const input = byteReader(source);
  const not = () => problem("NOT_AGE", "This is not an encrypted backup.");
  if ((await input.line()) !== VERSION) throw not();
  let header = `${VERSION}\n`;
  let fileKey;
  let mac;
  while (!mac) {
    const line = await input.line();
    if (line.startsWith("--- ")) {
      mac = unbase64(line.slice(4));
      if (!mac) throw not();
      header += "---";
      break;
    }
    const [arrow, type, ...words] = line.split(" ");
    if (arrow !== "->" || !type) throw not();
    header += `${line}\n`;
    // A recipient's body is base64 in lines of 64; a shorter line ends it.
    let body = "";
    for (;;) {
      const part = await input.line();
      header += `${part}\n`;
      body += part;
      if (part.length < 64) break;
    }
    if (fileKey || type !== "X25519" || words.length !== 1) continue;
    const senderShare = unbase64(words[0]);
    const wrapped = unbase64(body);
    if (senderShare?.length !== 32 || wrapped?.length !== 32) throw not();
    try {
      const shared = diffieHellman({
        privateKey: mine,
        publicKey: publicKey(senderShare),
      });
      fileKey = unseal(
        wrappingKey(shared, senderShare, myShare),
        Buffer.alloc(12),
        wrapped,
      );
    } catch {
      // Encrypted for a different key.
    }
  }
  if (!fileKey)
    throw problem("WRONG_KEY", "That backup key does not open this backup.");
  const damaged = () =>
    problem("DAMAGED", "The backup file is damaged or incomplete.");
  const expected = createHmac(
    "sha256",
    derive(fileKey, Buffer.alloc(0), "header"),
  )
    .update(header)
    .digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected))
    throw damaged();
  const nonce = await input.take(16);
  if (nonce.length !== 16) throw damaged();
  const payloadKey = derive(fileKey, nonce, "payload");
  let chunk = await input.take(CHUNK + TAG);
  for (let count = 0; ; count++) {
    const next = await input.take(CHUNK + TAG);
    const last = next.length === 0;
    // Only a file with no contents at all may end on an empty chunk.
    if (chunk.length < TAG || (count > 0 && chunk.length === TAG))
      throw damaged();
    let plain;
    try {
      plain = unseal(payloadKey, chunkNonce(count, last), chunk);
    } catch {
      throw damaged();
    }
    yield plain;
    if (last) return;
    chunk = next;
  }
}
