import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { register } from "./worker.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const records = new Map();
  let fail = false;
  const env = {
    DB: {
      prepare: (sql) => ({
        bind: (...args) => ({
          run: () => db.prepare(sql).run(...args),
          first: () => db.prepare(sql).get(...args),
        }),
      }),
    },
  };
  async function call(url, init) {
    if (url.startsWith("https://home.bravebrand.com/"))
      return Response.json({
        tier: url.includes("b".repeat(24)) ? "none" : "standard",
      });
    if (init.method === "POST") {
      if (fail) {
        fail = false;
        return new Response("", { status: 503 });
      }
      const record = JSON.parse(init.body);
      records.set(record.name, record);
      return Response.json({ success: true });
    }
    const record = records.get(new URL(url).searchParams.get("name"));
    return Response.json({ success: true, result: record ? [record] : [] });
  }
  const ip = "65.21.191.20";
  async function send(overrides = {}, source = ip) {
    const request = new Request("https://example.test/v1/address", {
      method: "POST",
      headers: { "CF-Connecting-IP": source, "Content-Length": "300" },
      body: JSON.stringify({
        slug: "acme",
        owner: "a".repeat(64),
        membership: "a".repeat(24),
        ip,
        ...overrides,
      }),
    });
    return register(request, env, call);
  }
  return {
    records,
    send,
    failOnce: () => {
      fail = true;
    },
  };
}
test("authenticated VPS claims a DNS-only address and retries without duplicating it", async () => {
  const f = fixture();
  assert.equal((await f.send()).status, 200);
  assert.equal((await f.send()).status, 200);
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get("acme.workrooms.bravebrand.com").proxied, false);
  assert.equal((await f.send({ owner: "b".repeat(64) })).status, 409);
  assert.equal((await f.send({ slug: "another" })).status, 409);
  assert.equal((await f.send({ ip: "8.8.8.8" }, "8.8.8.8")).status, 409);
});
test("incorrect source and invalid membership create no records", async () => {
  const f = fixture();
  assert.equal((await f.send({}, "8.8.8.8")).status, 400);
  assert.equal((await f.send({ membership: "b".repeat(24) })).status, 403);
  assert.equal(f.records.size, 0);
});
test("foreign records survive and another name can be chosen", async () => {
  const f = fixture();
  f.records.set("acme.workrooms.bravebrand.com", {
    type: "CNAME",
    content: "old.test",
  });
  assert.equal((await f.send()).status, 409);
  assert.equal((await f.send({ slug: "another" })).status, 200);
});
test("provider failure leaves the reservation recoverable only by the original VPS", async () => {
  const f = fixture();
  f.failOnce();
  await assert.rejects(f.send());
  assert.equal((await f.send({ owner: "b".repeat(64) })).status, 409);
  assert.equal((await f.send()).status, 200);
});
