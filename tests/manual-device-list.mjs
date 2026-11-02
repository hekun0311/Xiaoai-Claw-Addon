import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../assets/ui/xiaoai-console.js", import.meta.url), "utf8");
const ast = ts.createSourceFile("console.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = new Set(["buildDeviceListButtonLabel", "setDeviceListVisible", "loadDeviceList", "toggleDeviceList"]);
const functions = [];
function visit(node) {
    if (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) functions.push(node.getText(ast));
    ts.forEachChild(node, visit);
}
visit(ast);

function setup(fetch) {
    const context = vm.createContext({
        state: { bootstrap: { authenticated: true }, deviceListLoading: false, deviceListLoaded: false },
        els: { deviceList: {}, deviceListShell: {}, toggleDeviceListBtn: {} },
        API: { deviceList: "/device/list" }, apiFetch: fetch,
        escapeHtml: String, renderDeviceList() {}, showToast() {},
    });
    vm.runInContext(functions.join("\n"), context);
    return context;
}

test("device list has exactly one fetch entry, inside the explicit button handler", () => {
    const callers = [];
    function scan(node, owner = "") {
        if (ts.isFunctionDeclaration(node)) owner = node.name?.text || owner;
        if (ts.isCallExpression(node) && node.expression.getText(ast) === "loadDeviceList") callers.push(owner);
        ts.forEachChild(node, child => scan(child, owner));
    }
    scan(ast);
    assert.deepEqual(callers, ["toggleDeviceList"]);
});

test("opening/rendering the list makes no request; each click obtains or updates it", async () => {
    let requests = 0;
    const context = setup(async () => { requests++; return { items: [] }; });
    vm.runInContext("setDeviceListVisible(true); buildDeviceListButtonLabel()", context);
    assert.equal(requests, 0);
    assert.equal(vm.runInContext("buildDeviceListButtonLabel()", context), "获取设备列表");
    await vm.runInContext("toggleDeviceList()", context);
    assert.equal(requests, 1);
    assert.equal(vm.runInContext("buildDeviceListButtonLabel()", context), "更新设备列表");
    await vm.runInContext("toggleDeviceList()", context);
    assert.equal(requests, 2);
});

test("in-flight clicks and status renders cannot enable duplicate fetches", async () => {
    let release;
    let requests = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const context = setup(async () => { requests++; await gate; return { items: [] }; });
    const first = vm.runInContext("toggleDeviceList()", context);
    assert.equal(context.els.toggleDeviceListBtn.disabled, true);
    assert.equal(context.els.toggleDeviceListBtn.textContent, "正在获取…");
    await vm.runInContext("toggleDeviceList()", context);
    assert.equal(requests, 1);
    release(); await first;
    assert.equal(context.els.toggleDeviceListBtn.disabled, false);
});

test("failure remains visible and has no automatic retry", async () => {
    let requests = 0;
    const context = setup(async () => { requests++; throw new Error("HTTP 429"); });
    await vm.runInContext("toggleDeviceList()", context);
    assert.match(context.els.deviceList.innerHTML, /HTTP 429/);
    vm.runInContext("setDeviceListVisible(true)", context);
    assert.equal(requests, 1);
});

test("logged-out clicks do not fetch", async () => {
    const context = setup(async () => { assert.fail("unexpected fetch"); });
    context.state.bootstrap = { authenticated: false };
    await vm.runInContext("toggleDeviceList()", context);
});
