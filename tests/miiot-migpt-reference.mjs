// Usage: node --openssl-legacy-provider tests/miiot-migpt-reference.mjs ../migpt-cli
import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { XiaomiAccountClient, MiIOClient } from "../dist/src/xiaomi-client.js";

assert.ok(process.argv[2], "Pass the working MiGPT checkout as the reference");
const reference = resolve(process.argv[2], "node_modules");
const axios = (await import(pathToFileURL(resolve(reference, "axios/index.js")))).default;
let referenceRequest;
axios.defaults.adapter = async config => {
    referenceRequest = config;
    const form = new URLSearchParams(config.data);
    return {
        status: 200, statusText: "OK", config, headers: {},
        data: encryptResponse(form.get("_nonce"), JSON.stringify({ code: 0, result: { list: [] } })),
    };
};
const { MiIOT } = await import(pathToFileURL(resolve(reference, "mi-service-lite/dist/index.js")));
const secret = Buffer.from("reference-test-secret").toString("base64");
const token = { userId: "test-user", cUserId: "test-cuser", deviceId: "test-device", xiaomiio: [secret, "test-service-token"] };
function keyFor(nonce) {
    return createHash("sha256").update(Buffer.concat([Buffer.from(secret, "base64"), Buffer.from(nonce, "base64")])).digest();
}
function encryptResponse(nonce, text, gzip = false) {
    const cipher = createCipheriv("rc4", keyFor(nonce), null);
    cipher.update(Buffer.alloc(1024));
    return cipher.update(gzip ? gzipSync(Buffer.from(text)) : Buffer.from(text)).toString("base64");
}
let sequence = 0;
function client() {
    const account = new XiaomiAccountClient({ username: `reference-${++sequence}`, debugLogEnabled: false });
    account.token = structuredClone(token);
    account.ensureSid = async () => {};
    return account;
}
const originalFetch = globalThis.fetch;
const originalRandom = Math.random;
try {
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return Response.json({ code: 0, result: { list: [] } });
    };
    await new MiIOClient(client(), "cn").deviceListFull();
    const form = new URLSearchParams(request.options.body);
    const nonce = Buffer.from(form.get("_nonce"), "base64");
    let offset = 0;
    Math.random = () => nonce[offset++] / 256;
    await new MiIOT({
        userId: token.userId, deviceId: token.deviceId, serviceToken: token.xiaomiio[1],
        pass: { ssecurity: secret, cUserId: token.cUserId },
    }).getDevices();
    Math.random = originalRandom;
    assert.equal(offset, 12);
    const actualParams = Object.fromEntries(form);
    const expectedParams = Object.fromEntries(new URLSearchParams(referenceRequest.data));
    assert.deepEqual(actualParams, expectedParams, "encrypted data, stream hash, nonce and signature match the actual MiGPT dependency");
    assert.equal(request.url, referenceRequest.url);
    for (const name of ["User-Agent", "x-xiaomi-protocal-flag-cli", "miot-accept-encoding", "miot-encrypt-algorithm"]) {
        assert.equal(request.options.headers.get(name), referenceRequest.headers.get(name), name);
    }
    const cookies = value => Object.fromEntries(value.split(";").map(part => part.trim()).filter(Boolean).map(part => {
        const index = part.indexOf("="); return [part.slice(0, index), part.slice(index + 1)];
    }));
    const actualCookies = cookies(request.options.headers.get("Cookie"));
    assert.deepEqual(actualCookies, cookies(referenceRequest.headers.get("Cookie")));

    for (const gzip of [false, true]) {
        globalThis.fetch = async (_url, options) => {
            const params = new URLSearchParams(options.body);
            const text = JSON.stringify({ code: 0, result: { list: [{ did: "mock-device" }] } });
            return new Response(encryptResponse(params.get("_nonce"), text, gzip), {
                headers: gzip ? { "miot-content-encoding": "GZIP" } : {},
            });
        };
        const devices = await new MiIOClient(client(), "cn").deviceListFull();
        assert.equal(devices[0].did, "mock-device", `response decryption, gzip=${gzip}`);
    }
    let requests = 0;
    const account = client();
    account.refreshSidSerialized = async () => { assert.fail("429 must not login"); };
    globalThis.fetch = async () => {
        requests++;
        return Response.json({ code: -127, result: { wait_second: 30 } }, { status: 429 });
    };
    const miio = new MiIOClient(account, "cn");
    await assert.rejects(miio.deviceListFull(), /HTTP 429/);
    await assert.rejects(miio.deviceListFull(), /HTTP 429/);
    assert.equal(requests, 1);
    process.stdout.write("MiGPT reference passed: exact request body/headers/cookies, encrypted response, GZIP, 429 cooldown. No live calls.\n");
} finally {
    globalThis.fetch = originalFetch;
    Math.random = originalRandom;
}
