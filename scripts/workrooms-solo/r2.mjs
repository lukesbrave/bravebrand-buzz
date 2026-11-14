// Talks to Cloudflare R2 through its S3-compatible interface: upload, list,
// download and delete inside one bucket, signed with the owner's access key
// (AWS Signature Version 4). Written with Node alone; the secret half of the
// access key comes from the credential store and is never written anywhere.
import { createHash, createHmac } from "node:crypto";
import { createWriteStream, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sleep } from "./common.mjs";

// R2 wants every part but the last the same size, at least 5 MiB, and at most
// 10,000 of them: 16 MiB parts carry a backup of up to 160 GB.
const PART = 16 * 1024 * 1024;
const hash = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const encode = (text) =>
  encodeURIComponent(text).replace(
    /[!'()*]/g,
    (letter) => `%${letter.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const tag = (xml, name) =>
  [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "g"))].map(
    (match) => match[1],
  );

/** The address of an R2 account's storage, or undefined if `text` is not one.
 * A plain http address is accepted only for this computer, for tests. */
export function endpointFrom(text) {
  try {
    const url = new URL(text);
    const local = ["127.0.0.1", "localhost"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && local)
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

export function r2({ endpoint, bucket, keyId }, secret) {
  const host = new URL(endpoint).host;

  async function call(
    method,
    key,
    { query = {}, body = Buffer.alloc(0) } = {},
  ) {
    const path = `/${bucket}${key ? `/${key.split("/").map(encode).join("/")}` : ""}`;
    const search = Object.keys(query)
      .sort()
      .map((name) => `${encode(name)}=${encode(String(query[name]))}`)
      .join("&");
    const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const day = stamp.slice(0, 8);
    const headers = {
      host,
      "x-amz-content-sha256": hash(body),
      "x-amz-date": stamp,
    };
    const names = Object.keys(headers).join(";");
    const scope = `${day}/auto/s3/aws4_request`;
    const request = [
      method,
      path,
      search,
      ...Object.entries(headers).map(([name, value]) => `${name}:${value}`),
      "",
      names,
      headers["x-amz-content-sha256"],
    ].join("\n");
    const signingKey = ["auto", "s3", "aws4_request"].reduce(
      hmac,
      hmac(`AWS4${secret}`, day),
    );
    const signature = hmac(
      signingKey,
      ["AWS4-HMAC-SHA256", stamp, scope, hash(request)].join("\n"),
    ).toString("hex");
    const { host: _, ...sent } = headers;
    const response = await fetch(
      `${endpoint}${path}${search ? `?${search}` : ""}`,
      {
        method,
        headers: {
          ...sent,
          authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
        },
        body: method === "PUT" || method === "POST" ? body : undefined,
      },
    );
    if (!response.ok) {
      const [code] = tag(await response.text(), "Code");
      throw Object.assign(
        new Error(
          `Cloudflare answered ${response.status}${code ? ` (${code})` : ""}.`,
        ),
        { status: response.status },
      );
    }
    return response;
  }

  /** Tries again after a network fault or a fault on Cloudflare's side. */
  async function steady(run) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        if (attempt === 4 || (error.status && error.status < 500)) throw error;
        await sleep(attempt * 3_000);
      }
    }
  }

  return {
    /** Uploads a file under a name, in parts when it is large. */
    async upload(key, file) {
      const size = statSync(file).size;
      const handle = await open(file, "r");
      const read = async (from, length) => {
        const { buffer } = await handle.read(
          Buffer.alloc(length),
          0,
          length,
          from,
        );
        return buffer;
      };
      try {
        if (size <= PART) {
          const body = await read(0, size);
          await steady(() => call("PUT", key, { body }));
          return;
        }
        const started = await steady(() =>
          call("POST", key, { query: { uploads: "" } }),
        );
        const [uploadId] = tag(await started.text(), "UploadId");
        try {
          const parts = [];
          for (let from = 0; from < size; from += PART) {
            const body = await read(from, Math.min(PART, size - from));
            const partNumber = parts.length + 1;
            const sent = await steady(() =>
              call("PUT", key, { query: { partNumber, uploadId }, body }),
            );
            parts.push(
              `<Part><PartNumber>${partNumber}</PartNumber><ETag>${sent.headers.get("etag")}</ETag></Part>`,
            );
          }
          const finished = await steady(() =>
            call("POST", key, {
              query: { uploadId },
              body: Buffer.from(
                `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`,
              ),
            }),
          );
          // This one call can report a failure inside a successful answer.
          const [code] = tag(await finished.text(), "Code");
          if (code)
            throw new Error(
              `Cloudflare could not finish the upload (${code}).`,
            );
        } catch (error) {
          await call("DELETE", key, { query: { uploadId } }).catch(() => {});
          throw error;
        }
      } finally {
        await handle.close();
      }
    },

    /** The names and sizes of everything in the bucket. */
    async list() {
      const found = [];
      for (let token; ; ) {
        const query = { "list-type": 2 };
        if (token) query["continuation-token"] = token;
        const page = await (
          await steady(() => call("GET", "", { query }))
        ).text();
        const sizes = tag(page, "Size");
        for (const [at, name] of tag(page, "Key").entries())
          found.push({ name, size: Number(sizes[at]) });
        [token] = tag(page, "NextContinuationToken");
        if (!token) return found;
      }
    },

    async download(key, file) {
      const response = await steady(() => call("GET", key));
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(file, { mode: 0o600 }),
      );
    },

    async text(key) {
      return (await steady(() => call("GET", key))).text();
    },

    async put(key, text) {
      await steady(() => call("PUT", key, { body: Buffer.from(text) }));
    },

    async remove(key) {
      await steady(() => call("DELETE", key));
    },
  };
}
