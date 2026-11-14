import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import { decodeNpub, encodeNpub, newSecretKey, publicKey } from "./common.mjs";

describe("workspace kit keys", () => {
  it("reads and writes npubs as nostr-tools does", () => {
    for (let round = 0; round < 200; round++) {
      const secret = generateSecretKey();
      const hex = getPublicKey(secret);
      const npub = nip19.npubEncode(hex);
      expect(decodeNpub(npub)).toBe(hex);
      expect(encodeNpub(hex)).toBe(npub);
      expect(publicKey(Buffer.from(secret).toString("hex"))).toBe(hex);
    }
  });

  it("keeps leading zeros", () => {
    const hex = `00${"ab".repeat(31)}`;
    expect(encodeNpub(hex)).toBe(nip19.npubEncode(hex));
    expect(decodeNpub(nip19.npubEncode(hex))).toBe(hex);
  });

  it("refuses anything that is not an npub", () => {
    const secret = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(secret));
    const swapped = npub.endsWith("q") ? "p" : "q";
    expect(decodeNpub(nip19.nsecEncode(secret))).toBeUndefined();
    expect(decodeNpub(npub.slice(0, -1) + swapped)).toBeUndefined();
    expect(decodeNpub(npub.toUpperCase())).toBeUndefined();
    expect(decodeNpub(npub.slice(0, -1))).toBeUndefined();
    expect(decodeNpub("")).toBeUndefined();
  });

  it("makes secret keys nostr-tools accepts", () => {
    const secret = newSecretKey();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKey(secret)).toBe(getPublicKey(Buffer.from(secret, "hex")));
  });
});
