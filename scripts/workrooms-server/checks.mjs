// What the app's first connection and linking a phone depend on, checked from
// the owner's computer against the community's public address. Shared by
// install.mjs and move.mjs.
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Whether wss://<host>/pair accepts a connection, as linking a phone needs. */
function pairs(host) {
  return new Promise((resolve) => {
    let socket;
    const done = (ok) => {
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        // Already closed.
      }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 10_000);
    try {
      socket = new WebSocket(`wss://${host}/pair`);
      socket.addEventListener("open", () => done(true));
      socket.addEventListener("error", () => done(false));
    } catch {
      done(false);
    }
  });
}

/**
 * What is wrong with https://<host> as the community whose identity is
 * `relay`, or undefined when nothing is: it answers as that community,
 * refuses an anonymous read, hides its operator routes and accepts a phone
 * link. It waits up to five minutes for the certificate to be issued.
 */
export async function publicProblem(host, relay) {
  const origin = `https://${host}`;
  const reach = (path, init) =>
    fetch(origin + path, { ...init, signal: AbortSignal.timeout(10_000) });
  let self;
  for (let waited = 0; waited <= 300 && self !== relay; waited += 5) {
    self = await reach("/", { headers: { Accept: "application/nostr+json" } })
      .then((response) => response.json())
      .then(
        (body) => body.self,
        () => undefined,
      );
    if (self !== relay) await sleep(5_000);
  }
  if (self !== relay)
    return `${origin} is not answering as this community yet. The certificate may still be issuing: run the same command again in a minute.`;
  const anonymous = await reach("/query", { method: "POST", body: "{}" });
  if (anonymous.status !== 401)
    return `Expected ${origin} to refuse an anonymous read, got ${anonymous.status}.`;
  const operator = await reach("/operator/communities");
  if (operator.status !== 404)
    return `Expected ${origin} to hide operator routes, got ${operator.status}.`;
  if (!(await pairs(host)))
    return `${origin} is running, but its phone-linking address (wss://${host}/pair) did not accept a connection. Run the same command again.`;
  return undefined;
}
