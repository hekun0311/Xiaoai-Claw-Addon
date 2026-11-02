import { readFile } from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { Readable } from "stream";
import { createInterface } from "readline";
import { writePrivateJsonFile } from "./state-store.js";

export interface SpeechSettings {
    engine: "xiaomi" | "volcano";
    resourceId: "seed-icl-2.0" | "seed-tts-2.0";
    model: "seed-tts-2.0-standard" | "seed-tts-2.0-expressive";
    speaker: string;
    apiKey: string;
}
const defaults: SpeechSettings = {
    engine: "xiaomi", resourceId: "seed-icl-2.0", model: "seed-tts-2.0-standard", speaker: "", apiKey: "",
};

export class SpeechCancelledError extends Error {
    constructor() { super("本轮语音已取消"); this.name = "AbortError"; }
}

export async function synthesizeVolcano(settings: SpeechSettings, text: string, signal: AbortSignal): Promise<Buffer> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 60_000);
    const requestId = randomUUID();
    // Provider response bodies/messages are deliberately not surfaced: they may echo submitted data.
    try {
        const response = await fetch("https://openspeech.bytedance.com/api/v3/tts/unidirectional", {
            method: "POST", signal: AbortSignal.any([signal, timeout.signal]),
            headers: { "Content-Type": "application/json", "X-Api-Key": settings.apiKey,
                "X-Api-Resource-Id": settings.resourceId, "X-Api-Request-Id": requestId },
            body: JSON.stringify({ user: { uid: "xiaoai-cloud" }, req_params: {
                text, speaker: settings.speaker,
                ...(settings.resourceId === "seed-icl-2.0" ? { model: settings.model } : {}),
                audio_params: { format: "mp3", sample_rate: 24000 },
            } }),
        });
        if (!response.ok) throw new Error(`火山 HTTP ${response.status}；请求 ${requestId}`);
        if (!response.body) throw new Error(`火山未返回音频；请求 ${requestId}`);
        const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        const lines = createInterface({ input: body, crlfDelay: Infinity });
        const chunks: Buffer[] = [];
        let complete = false;
        try {
            for await (const line of lines) {
                if (!line.trim()) continue;
                let event: { code: number; data?: string };
                try { event = JSON.parse(line); } catch { throw new Error(`火山响应格式错误；请求 ${requestId}`); }
                if (event.code !== 0 && event.code !== 20000000) {
                    const code = Number.isFinite(event.code) ? event.code : "unknown";
                    throw new Error(`火山业务错误 ${code}；请求 ${requestId}`);
                }
                if (event.data) chunks.push(Buffer.from(event.data, "base64"));
                if (event.code === 20000000) { complete = true; break; }
            }
        } finally { lines.close(); body.destroy(); }
        if (signal.aborted) throw new SpeechCancelledError();
        if (!complete) throw new Error(`火山音频流中断；请求 ${requestId}`);
        const audio = Buffer.concat(chunks);
        if (audio.length < 3 || !(audio.subarray(0, 3).toString() === "ID3" || (audio[0] === 255 && (audio[1] & 224) === 224))) {
            throw new Error(`火山未返回有效 MP3；请求 ${requestId}`);
        }
        return audio;
    } catch (error) {
        if (signal.aborted) throw new SpeechCancelledError();
        if (timeout.signal.aborted) throw new Error(`火山合成超时；请求 ${requestId}`);
        if (error instanceof Error && error.message.startsWith("火山")) throw error;
        throw new Error(`火山请求失败；请求 ${requestId}`);
    } finally { clearTimeout(timer); }
}

export class SpeechService {
    private loaded?: Promise<SpeechSettings>;
    private saveQueue: Promise<unknown> = Promise.resolve();
    private epoch = 0;
    private controllers = new Set<AbortController>();
    private pending = new Map<string, Promise<Buffer>>();
    private cache = new Map<string, { audio: Buffer; expires: number }>();
    constructor(private readonly file: string) {}
    get generation() { return this.epoch; }
    isCurrent(generation: number) { return this.epoch === generation; }
    cancel() {
        this.epoch++;
        for (const controller of this.controllers) controller.abort();
        this.controllers.clear(); this.pending.clear();
    }
    private load(): Promise<SpeechSettings> {
        if (!this.loaded) this.loaded = (async () => {
            try {
                const parsed = JSON.parse(await readFile(this.file, "utf8"));
                return this.validate(parsed, defaults);
            } catch (error: any) {
                if (error?.code === "ENOENT") return { ...defaults };
                throw new Error("语音配置读取失败，请检查 speech-settings.json");
            }
        })();
        return this.loaded;
    }
    private validate(input: any, previous: SpeechSettings): SpeechSettings {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("语音配置无效");
        const next = { ...previous };
        for (const key of ["engine", "resourceId", "model", "speaker", "apiKey"] as const) {
            if (input[key] !== undefined) {
                if (typeof input[key] !== "string") throw new Error("语音配置字段类型错误");
                if (key === "apiKey" && !input[key].trim()) continue;
                (next as any)[key] = input[key].trim();
            }
        }
        if (input.clearApiKey === true) next.apiKey = "";
        if (!["xiaomi", "volcano"].includes(next.engine) || !["seed-icl-2.0", "seed-tts-2.0"].includes(next.resourceId) ||
            !["seed-tts-2.0-standard", "seed-tts-2.0-expressive"].includes(next.model)) throw new Error("请选择有效的语音引擎、服务和合成效果");
        if (next.engine === "volcano" && (!next.apiKey || !next.speaker)) throw new Error("请填写火山 API Key 和音色 ID");
        return next;
    }
    async publicSettings() {
        const { apiKey, ...settings } = await this.load();
        return { ...settings, hasApiKey: Boolean(apiKey) };
    }
    save(input: unknown) {
        const save = async () => {
            const next = this.validate(input, await this.load());
            await writePrivateJsonFile(this.file, next);
            this.cancel(); this.cache.clear(); this.loaded = Promise.resolve(next);
            return this.publicSettings();
        };
        const task = this.saveQueue.then(save, save);
        this.saveQueue = task.catch(() => undefined);
        return task;
    }
    async synthesize(text: string): Promise<Buffer> {
        const generation = this.epoch;
        const settings = await this.load();
        if (!this.isCurrent(generation)) throw new SpeechCancelledError();
        if (settings.engine !== "volcano") throw new Error("当前未选择火山语音");
        const key = createHash("sha256").update(JSON.stringify([settings, text])).digest("hex");
        const cached = this.cache.get(key);
        if (cached && cached.expires > Date.now()) return Buffer.from(cached.audio);
        const flightKey = `${generation}:${key}`;
        const existing = this.pending.get(flightKey);
        if (existing) return Buffer.from(await existing);
        const controller = new AbortController(); this.controllers.add(controller);
        const task = synthesizeVolcano(settings, text, controller.signal).then(audio => {
            if (!this.isCurrent(generation)) throw new SpeechCancelledError();
            this.cache.set(key, { audio, expires: Date.now() + 30 * 60_000 });
            while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
            return audio;
        });
        this.pending.set(flightKey, task);
        try { return Buffer.from(await task); }
        finally {
            this.controllers.delete(controller);
            if (this.pending.get(flightKey) === task) this.pending.delete(flightKey);
        }
    }
}
