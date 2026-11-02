import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { createXiaoaiCloudPlugin } from "../dist/src/provider.js";

await mkdir(resolve("../../tmp"), { recursive: true });
const workspace = await mkdtemp(join(resolve("../../tmp"), "agent-entries-"));
test.after(() => rm(workspace, { recursive: true }));

function setup() {
    let active = {
        agents: {
            defaults: { model: "deepseek/main-model", contextTokens: 16000 },
            entries: {
                main: { model: "deepseek/main-model", workspace: join(workspace, "main") },
                xiaoai: { model: "deepseek/xiaoai-model", contextTokens: 32000, workspace: join(workspace, "xiaoai") },
            },
        },
    };
    const plugin = createXiaoaiCloudPlugin({ runtime: { config: { current: () => active } } });
    plugin.loadConfig = async () => ({ openclawAgent: "xiaoai", openclawCliPath: "openclaw" });
    const writes = [];
    plugin.runOpenclawCli = async args => { writes.push(args); return ""; };
    plugin.scheduleGatewayRestart = () => {};
    return { plugin, writes, config: () => active, setConfig: value => { active = value; } };
}

test("reads xiaoai model/context/workspace from current entries rather than main defaults", async () => {
    const fixture = setup();
    const config = { openclawAgent: "xiaoai" };
    const model = await fixture.plugin.queryOpenclawAgentModelState(config);
    assert.equal(model.model, "deepseek/xiaoai-model");
    assert.equal(model.contextTokens, 32000);
    const next = structuredClone(fixture.config());
    next.agents.entries.xiaoai.model = "deepseek/updated-model";
    fixture.setConfig(next);
    assert.equal((await fixture.plugin.queryOpenclawAgentModelState(config)).model, "deepseek/updated-model");
    assert.equal(fixture.writes.length, 0);
});

test("context writes only agents.entries.xiaoai.contextTokens", async () => {
    const fixture = setup();
    const before = structuredClone(fixture.config());
    const result = await fixture.plugin.updateOpenclawAgentContextTokens(64000);
    assert.equal(result.changed, true);
    assert.equal(fixture.writes[0][3], "agents.entries.xiaoai.contextTokens");
    assert.equal(fixture.writes[0][4], "64000");
    assert.deepEqual(fixture.config(), before, "runtime snapshot must not be mutated directly");
});

test("model writes only agents.entries.xiaoai.model and unchanged values make no writes", async () => {
    const fixture = setup();
    const unchanged = await fixture.plugin.updateOpenclawAgentModel("deepseek/xiaoai-model");
    assert.equal(unchanged.changed, false);
    assert.equal(fixture.writes.length, 0);
    await fixture.plugin.updateOpenclawAgentModel("deepseek/next-model");
    assert.equal(fixture.writes[0][3], "agents.entries.xiaoai.model");
    assert.equal(fixture.config().agents.entries.main.model, "deepseek/main-model");
});

test("workspace edits/readback use xiaoai workspace and preserve main files", async () => {
    const fixture = setup();
    await mkdir(join(workspace, "main"), { recursive: true });
    await writeFile(join(workspace, "main", "IDENTITY.md"), "main identity");
    const result = await fixture.plugin.updateOpenclawWorkspaceFile("identity", { content: "xiaoai identity", enabled: true });
    assert.equal(result.file.enabled, true);
    assert.equal((await readFile(join(workspace, "xiaoai", "IDENTITY.md"), "utf8")).trim(), "xiaoai identity");
    assert.equal(await readFile(join(workspace, "main", "IDENTITY.md"), "utf8"), "main identity");
    const files = await fixture.plugin.queryOpenclawWorkspaceFilesState({ openclawAgent: "xiaoai" });
    assert.equal(files.files.find(file => file.id === "identity").enabled, true);
});

test("missing xiaoai remains an error and never creates an agent or uses main", async () => {
    const fixture = setup();
    delete fixture.config().agents.entries.xiaoai;
    await assert.rejects(fixture.plugin.updateOpenclawAgentContextTokens(64000), /没有找到 id 为 xiaoai/);
    assert.equal(fixture.writes.length, 0);
});
