import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { SpeechService, synthesizeVolcano } from '../dist/src/speech.js';
import { createXiaoaiCloudPlugin } from '../dist/src/provider.js';
import { Readable } from 'node:stream';

await mkdir(resolve('../../tmp'), { recursive: true });
const root = await mkdtemp(join(resolve('../../tmp'), 'speech-'));
const realFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = realFetch; return rm(root, { recursive: true }); });
const settings = { engine: 'volcano', apiKey: 'private-key', speaker: 'S_test', resourceId: 'seed-icl-2.0', model: 'seed-tts-2.0-standard' };
const mp3 = Buffer.from('ID3mock-mp3');
function response(events) {
    const bytes = Buffer.from(events.map(e => JSON.stringify(e)).join('\n'));
    return new Response(new ReadableStream({ start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7));
        c.close();
    } }));
}
function success() { return response([{ code: 0, data: mp3.subarray(0, 4).toString('base64') }, { code: 0, data: mp3.subarray(4).toString('base64') }, { code: 20000000 }]); }

test('settings default native, persist/reload, never return key, blank retains and explicit clear works', async () => {
    const file = join(root, 'settings.json');
    const service = new SpeechService(file);
    assert.equal((await service.publicSettings()).engine, 'xiaomi');
    assert.equal((await service.save(settings)).hasApiKey, true);
    assert.equal(JSON.stringify(await service.publicSettings()).includes('private-key'), false);
    await service.save({ apiKey: '', speaker: 'S_changed' });
    assert.equal(JSON.parse(await readFile(file, 'utf8')).apiKey, 'private-key');
    assert.equal((await new SpeechService(file).publicSettings()).speaker, 'S_changed');
    await assert.rejects(service.save({ clearApiKey: true }), /API Key/);
    await service.save({ engine: 'xiaomi', clearApiKey: true });
    assert.equal((await new SpeechService(file).publicSettings()).hasApiKey, false);
});

test('clone standard/expressive and system request fields; split response produces complete MP3', async () => {
    for (const resourceId of ['seed-icl-2.0', 'seed-tts-2.0']) {
        for (const model of ['seed-tts-2.0-standard', 'seed-tts-2.0-expressive']) {
            globalThis.fetch = async (url, init) => {
                assert.equal(url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
                assert.equal(init.headers['X-Api-Key'], settings.apiKey);
                assert.equal(init.headers['X-Api-Resource-Id'], resourceId);
                const body = JSON.parse(init.body);
                assert.equal(body.req_params.model, resourceId === 'seed-icl-2.0' ? model : undefined);
                assert.equal(body.req_params.audio_params.format, 'mp3');
                return success();
            };
            assert.deepEqual(await synthesizeVolcano({ ...settings, resourceId, model }, '你好', new AbortController().signal), mp3);
        }
    }
});

test('HTTP/business errors, missing completion, empty/invalid audio are rejected without provider data', async () => {
    const replies = [new Response('private-key text', { status: 403 }), response([{ code: 4500, message: 'private-key' }]), response([{ code: 0, data: mp3.toString('base64') }]), response([{ code: 20000000 }]), response([{ code: 0, data: Buffer.from('bad').toString('base64') }, { code: 20000000 }])];
    for (const reply of replies) {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return reply; };
        await assert.rejects(synthesizeVolcano(settings, '你好', new AbortController().signal), e => !e.message.includes('private-key'));
        assert.equal(calls, 1);
    }
});

test('deduplicates concurrent synthesis and invalidates cache on voice/key changes', async () => {
    const service = new SpeechService(join(root, 'cache.json'));
    await service.save(settings);
    let calls = 0;
    globalThis.fetch = async () => { calls++; await new Promise(r => setTimeout(r, 5)); return success(); };
    await Promise.all([service.synthesize('相同'), service.synthesize('相同')]);
    await service.synthesize('相同');
    assert.equal(calls, 1);
    await service.save({ speaker: 'S_next' });
    await service.synthesize('相同');
    await service.save({ apiKey: 'other-key' });
    await service.synthesize('相同');
    assert.equal(calls, 3);
});

test('new question/stop cancellation aborts pending synthesis and rejects stale audio', async () => {
    const service = new SpeechService(join(root, 'cancel.json'));
    await service.save(settings);
    let started;
    const ready = new Promise(r => { started = r; });
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        started(); init.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    });
    const pending = service.synthesize('旧问题');
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await ready; service.cancel(); await rejected;
});

function provider(service) {
    const p = createXiaoaiCloudPlugin({});
    p.speech = service;
    p.ensureActionContext = async () => ({});
    p.computeSpeakerReachableAudioRelayBaseUrls = async () => ['https://test.invalid'];
    p.getAudioRelayTailPaddingMs = () => 0;
    p.recordConsoleEvent = () => {};
    return p;
}
test('volcano uses relay, no native fallback on error, and stale relay is never dispatched', async () => {
    const service = new SpeechService(join(root, 'provider.json'));
    await service.save(settings);
    const p = provider(service);
    let native = 0, played = 0;
    p.playText = async () => { native++; return true; };
    p.registerBufferedAudioRelaySource = async audio => { assert.deepEqual(audio, mp3); return 'https://test.invalid/audio'; };
    p.playAudioUrl = async (_url, options) => { assert.equal(options.isCurrent(), true); played++; return { ok: true }; };
    globalThis.fetch = async () => success();
    await p.playSelectedText('回答');
    assert.equal(played, 1); assert.equal(native, 0);
    globalThis.fetch = async () => new Response('', { status: 403 });
    await assert.rejects(p.playSelectedText('失败'));
    assert.equal(native, 0);
    globalThis.fetch = async () => success();
    p.registerBufferedAudioRelaySource = async () => { service.cancel(); return 'https://test.invalid/stale'; };
    await assert.rejects(p.playSelectedText('过期'), { name: 'AbortError' });
    assert.equal(played, 1);
});

test('fire skips transition before selecting/synthesizing it; native restores prior path', async () => {
    const service = new SpeechService(join(root, 'transition.json'));
    await service.save(settings);
    const p = provider(service);
    p.playText = async () => { throw new Error('native transition reached'); };
    await p.sendTransitionPrompt();
    await service.save({ engine: 'xiaomi' });
    await assert.rejects(p.sendTransitionPrompt(), /native transition reached/);
});

test('settings/test endpoints retain console authentication and reject concurrent tests without history', async () => {
    const service = new SpeechService(join(root, 'api.json'));
    const p = provider(service);
    p.resolveConsoleAuthorization = async () => ({ authorized: true, expected: 'token', fromHeader: 'token' });
    p.isTrustedConsoleMutationRequest = () => false;
    const call = async (action, method = 'GET', body = {}) => {
        const request = Readable.from([Buffer.from(JSON.stringify(body))]);
        request.method = method; request.headers = { host: 'localhost' };
        const response = { setHeader() {}, end(value) { this.body = JSON.parse(value); } };
        await p.handleConsoleApiRoute({}, request, response, new URL('http://localhost'), '/api/' + action);
        return response;
    };
    const saved = await call('speech/settings', 'POST', settings);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.body.apiKey, undefined);
    assert.equal((await call('speech/settings')).body.hasApiKey, true);
    let release, count = 0;
    p.playSelectedText = async text => {
        assert.equal(text, '你好，这是音色测试。'); count++;
        return new Promise(resolve => { release = () => resolve(true); });
    };
    p.recordVoiceContextTurn = () => { throw new Error('test must not enter history'); };
    const first = call('speech/test', 'POST');
    while (!release) await new Promise(r => setImmediate(r));
    assert.equal((await call('speech/test', 'POST')).statusCode, 409);
    release(); assert.equal((await first).statusCode, 200); assert.equal(count, 1);
    p.resolveConsoleAuthorization = async () => ({ authorized: false });
    assert.equal((await call('speech/settings')).statusCode, 401);
    p.resolveConsoleAuthorization = async () => ({ authorized: true, expected: 'token' });
    assert.equal((await call('speech/settings', 'POST', { engine: 'xiaomi' })).statusCode, 403);
});
