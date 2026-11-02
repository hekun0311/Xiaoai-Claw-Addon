import assert from "node:assert/strict";
import test from "node:test";
import { XiaomiAccountClient, MiIOClient } from "../dist/src/xiaomi-client.js";

const url = "https://api.io.mi.com/app/home/device_list";
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let nextAccount = 0;

function client(username = `test-${++nextAccount}`) {
    const account = new XiaomiAccountClient({ username, debugLogEnabled: false });
    account.token = { userId: "test-user", deviceId: "test-device", xiaomiio: ["c2VjcmV0", "test-token"] };
    account.ensureSid = async () => {};
    account.loadTokenStore = async () => {};
    account.saveTokenStore = async () => {};
    return account;
}

test.afterEach(() => {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
});

test("429 retains login and prevents requests across clients until wait_second expires", async () => {
    let now = 100_000;
    Date.now = () => now;
    let requests = 0;
    let refreshes = 0;
    const account = client();
    account.refreshSidSerialized = async () => { refreshes++; };
    globalThis.fetch = async () => {
        requests++;
        return new Response(JSON.stringify({ code: -127, result: { wait_second: 30 } }), { status: 429 });
    };
    await assert.rejects(account.miRequest({ sid: "xiaomiio", url }), /HTTP 429/);
    await assert.rejects(client(account.username).miRequest({ sid: "xiaomiio", url }), /HTTP 429/);
    assert.equal(requests, 1);
    assert.equal(refreshes, 0);
    assert.ok(account.token.xiaomiio);
    now += 30_001;
    globalThis.fetch = async () => { requests++; return Response.json({ result: { list: [] } }); };
    await account.miRequest({ sid: "xiaomiio", url });
    assert.equal(requests, 2);
});

test("device discovery shares in-flight work and caches isolated copies for 60 seconds", async () => {
    let now = 200_000;
    Date.now = () => now;
    const account = client();
    let requests = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async () => {
        requests++;
        await gate;
        return Response.json({ result: { list: [{ did: "test" }] } });
    };
    const first = new MiIOClient(account, "cn").deviceListFull();
    const second = new MiIOClient(client(account.username), "cn").deviceListFull();
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(requests, 1);
    a[0].did = "changed";
    assert.equal(b[0].did, "test");
    await new MiIOClient(account, "cn").deviceListFull();
    assert.equal(requests, 1);
    now += 60_001;
    await new MiIOClient(account, "cn").deviceListFull();
    assert.equal(requests, 2);
});

test("non-auth server errors do not re-login and failures are not cached", async () => {
    const account = client();
    let requests = 0;
    account.refreshSidSerialized = async () => { assert.fail("unexpected login"); };
    globalThis.fetch = async () => { requests++; return Response.json({ code: -1 }, { status: 500 }); };
    await assert.rejects(account.miRequest({ sid: "xiaomiio", url }));
    await assert.rejects(account.miRequest({ sid: "xiaomiio", url }));
    assert.equal(requests, 2);
});

test("401 still refreshes once without waiting on its own discovery promise", async () => {
    const account = client();
    let refreshes = 0;
    let requests = 0;
    account.refreshSidSerialized = async () => { refreshes++; };
    globalThis.fetch = async () => ++requests === 1
        ? Response.json({}, { status: 401 })
        : Response.json({ result: { list: [] } });
    await account.miRequest({ sid: "xiaomiio", url });
    assert.equal(refreshes, 1);
    assert.equal(requests, 2);
});

test("non-JSON 429 also retains login and applies cooldown", async () => {
    const account = client();
    let requests = 0;
    account.refreshSidSerialized = async () => { assert.fail("unexpected login"); };
    globalThis.fetch = async () => { requests++; return new Response("Too Many Requests", { status: 429 }); };
    await assert.rejects(account.miRequest({ sid: "xiaomiio", url }), /HTTP 429/);
    await assert.rejects(account.miRequest({ sid: "xiaomiio", url }), /HTTP 429/);
    assert.equal(requests, 1);
});

test("cache is separated by account and cleared on logout", async () => {
    const account = client();
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ result: { list: [] } }); };
    await account.miRequest({ sid: "xiaomiio", url });
    await client().miRequest({ sid: "xiaomiio", url });
    assert.equal(requests, 2);
    await account.invalidateSid("xiaomiio");
    account.token.xiaomiio = ["c2VjcmV0", "new-test-token"];
    await account.miRequest({ sid: "xiaomiio", url });
    assert.equal(requests, 3);
});

test("speaker actions are neither cached nor deduplicated", async () => {
    const account = client();
    let requests = 0;
    globalThis.fetch = async () => { requests++; return Response.json({ code: 0 }); };
    await Promise.all([1, 2].map(() => account.miRequest({ sid: "xiaomiio", url: "https://api.io.mi.com/app/miotspec/action" })));
    assert.equal(requests, 2);
});
