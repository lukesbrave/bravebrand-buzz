// DNS-only service. Requests come directly from the client's VPS over IPv4.
export const suffix = "workrooms.bravebrand.com";

export async function register(request, env, call = fetch) {
  if (
    request.method !== "POST" ||
    new URL(request.url).pathname !== "/v1/address"
  )
    return new Response("Unknown route", { status: 404 });
  const ip = request.headers.get("CF-Connecting-IP");
  if (request.headers.has("CF-Worker"))
    return new Response("Register directly from your VPS.", { status: 403 });
  const length = Number(request.headers.get("Content-Length"));
  if (!Number.isInteger(length) || length < 2 || length > 1024)
    return new Response("Send a bounded JSON request.", { status: 400 });
  const raw = await request.text();
  if (raw.length > 1024)
    return new Response("Invalid request", { status: 400 });
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Invalid request", { status: 400 });
  }
  if (!body || typeof body !== "object")
    return new Response("Invalid request", { status: 400 });
  const { slug, owner, membership } = body;
  if (
    !ip ||
    !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) ||
    ip !== body.ip ||
    typeof slug !== "string" ||
    !/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(slug) ||
    typeof owner !== "string" ||
    !/^[a-f0-9]{64}$/.test(owner) ||
    typeof membership !== "string" ||
    !/^[a-f0-9]{24}$/.test(membership)
  )
    return new Response("Check the workspace name, access link and VPS IPv4.", {
      status: 400,
    });
  const member = await call(
    `https://home.bravebrand.com/${membership}/membership.json`,
    { redirect: "error" },
  );
  if (
    !member.ok ||
    !["standard", "premium"].includes((await member.json()).tier)
  )
    return new Response("The course access link could not be verified.", {
      status: 403,
    });

  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)),
    ),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const hostname = `${slug}.${suffix}`;
  const endpoint =
    "https://api.cloudflare.com/client/v4/zones/" +
    env.ZONE_ID +
    "/dns_records";
  const headers = {
    Authorization: `Bearer ${env.DNS_TOKEN}`,
    "Content-Type": "application/json",
  };
  async function records() {
    const res = await call(`${endpoint}?name=${hostname}`, { headers });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error("DNS lookup failed");
    return data.result;
  }
  const matches = (rows) =>
    rows.length === 1 &&
    rows[0].type === "A" &&
    rows[0].content === ip &&
    rows[0].proxied === false &&
    rows[0].comment === `workrooms:${hash}`;
  let rows = await records();
  if (rows.length && !matches(rows))
    return new Response("That name or server already has a workspace.", {
      status: 409,
    });
  // Both unique constraints are applied atomically. Retries can only finish the same claim.
  await env.DB.prepare("INSERT OR IGNORE INTO workrooms VALUES (?, ?, ?)")
    .bind(slug, ip, hash)
    .run();
  const row = await env.DB.prepare(
    "SELECT ip, owner_hash FROM workrooms WHERE slug=?",
  )
    .bind(slug)
    .first();
  if (row?.ip !== ip || row.owner_hash !== hash)
    return new Response("That name or server already has a workspace.", {
      status: 409,
    });

  if (!rows.length) {
    const res = await call(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "A",
        name: hostname,
        content: ip,
        proxied: false,
        ttl: 300,
        comment: `workrooms:${hash}`,
      }),
    });
    if (!res.ok && res.status >= 500) throw new Error("DNS unavailable");
    rows = await records();
  }
  if (!matches(rows))
    return new Response(
      "DNS could not confirm this reservation. Existing records are protected.",
      { status: 409 },
    );
  return Response.json(
    { hostname },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export default {
  async fetch(request, env) {
    try {
      return await register(request, env);
    } catch {
      return new Response("Address service unavailable. Retry setup.", {
        status: 503,
      });
    }
  },
};
