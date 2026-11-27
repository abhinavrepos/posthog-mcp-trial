// openai_compatible provider (vLLM / Ollama / LM Studio / TGI) and the egress policy that depends on self_hosted.
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'rv-oai-'))
process.env.TRIAGE_DB = join(dir, 'triage.db')
process.env.POSTHOG_PROJECT_ID ||= '1'
process.env.FEATURE_REPLAY_VISION = 'on'
test.after(() => rmSync(dir, { recursive: true, force: true }))
const PV = await import('../src/core/replay-vision-provider.ts')
const L = await import('../src/core/replay-vision-llm.ts')
const W = await import('../src/core/replay-vision-watch.ts')

type Call = { url: string; body: any; headers: Record<string, string> }
function fakeServer(answer: (body: any) => unknown, models = ['qwen2.5-vl-7b']) {
    const calls: Call[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 })
        const body = JSON.parse(String(init?.body))
        calls.push({ url: String(url), body, headers })
        return new Response(JSON.stringify(answer(body)), { status: 200 })
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
}
const params = (images = 0) => ({
    model: 'claude-haiku-5-5', max_tokens: 512, system: 'You explain friction.',
    messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'facts' }, ...Array.from({ length: images }, () => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'iVBORw0KGgo=' } }))] }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PV.EXPLANATION_SCHEMA as unknown as Record<string, unknown> } },
}) as never

test('request conversion: system, text, base64 images as data URLs, max_tokens, JSON schema (or JSON mode), configured model', () => {
    const b = PV.toChatBody(params(2), 'qwen2.5-vl-7b', 'json_schema')
    assert.equal(b.model, 'qwen2.5-vl-7b')
    assert.deepEqual(b.messages[0], { role: 'system', content: 'You explain friction.' })
    const parts = b.messages[1]!.content as { type: string; image_url?: { url: string } }[]
    assert.equal(parts.filter((p) => p.type === 'image_url').length, 2)
    assert.ok(parts.every((p) => p.type !== 'image_url' || p.image_url!.url === 'data:image/png;base64,iVBORw0KGgo='))
    assert.equal(b.max_tokens, 512)
    assert.equal((b.response_format as any).type, 'json_schema')
    assert.deepEqual((b.response_format as any).json_schema.schema, PV.EXPLANATION_SCHEMA)
    assert.equal((PV.toChatBody(params(0), 'm', 'json_object').response_format as any).type, 'json_object')
    assert.equal(PV.toChatBody(params(0), 'm', 'json_schema').messages[1]!.content, 'facts', 'text-only content stays a string (widest server support)')
})

test('response conversion: a Messages-shaped object the existing parsers accept; length and refusal mapped; usage carried', () => {
    const ok = PV.fromChatResponse({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } }, 'm') as any
    assert.deepEqual([ok.type, ok.role, ok.content[0].text, ok.stop_reason, ok.usage.input_tokens, ok.usage.output_tokens], ['message', 'assistant', '{"a":1}', 'end_turn', 120, 30])
    assert.equal((PV.fromChatResponse({ choices: [{ message: { content: '{' }, finish_reason: 'length' }] }, 'm') as any).stop_reason, 'max_tokens')
    assert.equal((PV.fromChatResponse({ choices: [{ message: { content: null, refusal: 'no' } }] }, 'm') as any).stop_reason, 'refusal')
})

test('provider: POSTs to /chat/completions with the key, times out, reports capabilities from /models + the operator vision flag', async () => {
    const answer = { choices: [{ message: { content: '{"decision":"insufficient_evidence","likely_cause":"","fix":"","cited_event_ids":[],"confidence":"low","unsupported":[]}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }
    const srv = fakeServer(() => answer)
    const p = new PV.OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen2.5-vl-7b', apiKey: 'k', selfHosted: true, vision: true, jsonMode: 'json_schema', timeoutMs: 5000, fetchImpl: srv.fetchImpl })
    assert.equal(p.priced, false); assert.equal(p.batch, false)
    const sub = await p.submit('rv_x_12345678', params(1))
    assert.equal(srv.calls[0]!.url, 'http://127.0.0.1:8000/v1/chat/completions')
    assert.equal(srv.calls[0]!.headers.authorization, 'Bearer k')
    assert.equal(PV.parseProviderMessage(sub.immediate).ok, true)
    assert.deepEqual(await p.capabilities(), { text: true, batch: false, image_input: true, verified: true })
    const absent = new PV.OpenAICompatibleProvider({ ...p.opts, model: 'not-served' })
    assert.equal((await absent.capabilities()).verified, false, 'a model the server does not list is not verified')
    const slow = new PV.OpenAICompatibleProvider({ ...p.opts, timeoutMs: 50, fetchImpl: ((_u: string, init?: RequestInit) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch })
    await assert.rejects(slow.submit('rv_y_12345678', params(0)), /aborted/)
    assert.throws(() => new PV.OpenAICompatibleProvider({ ...p.opts, baseUrl: 'file:///etc/passwd' }))
})

test('selection and egress policy: private/loopback base URL = self-hosted unless declared; external providers get no frames', async () => {
    Object.assign(process.env, { REPLAY_VISION_PROVIDER: 'openai_compatible', REPLAY_VISION_OAI_BASE_URL: 'http://localhost:11434/v1', REPLAY_VISION_OAI_MODEL: 'qwen2.5vl' })
    delete process.env.REPLAY_VISION_OAI_SELF_HOSTED
    const local = L.selectProvider()!
    assert.equal(local.name, 'openai_compatible'); assert.equal(local.selfHosted, true)
    process.env.REPLAY_VISION_OAI_BASE_URL = 'https://api.example.com/v1'
    assert.equal(L.selectProvider()!.selfHosted, false, 'a public host is external unless declared')
    process.env.REPLAY_VISION_OAI_SELF_HOSTED = 'true'
    assert.equal(L.selectProvider()!.selfHosted, true, 'an operator may declare their own public endpoint self-hosted')
    for (const [u, v] of [['http://10.1.2.3:8000', true], ['http://192.168.0.5', true], ['http://172.20.0.2', true], ['http://vllm', true], ['http://gpu.internal', true], ['https://8.8.8.8', false], ['https://models.example.org', false]] as const) assert.equal(L.isPrivateHost(u), v, u)
    process.env.REPLAY_VISION_ALLOW_EXTERNAL = 'on'
    assert.match(L.providerStatus().detail, /self-hosted/)
    process.env.REPLAY_VISION_OAI_SELF_HOSTED = 'false'
    assert.match(L.providerStatus().detail, /never sent to an external provider/)
    const ext = L.selectProvider()!
    assert.equal((await W.watchFullyAvailability(ext)).available, false)
    for (const k of ['REPLAY_VISION_PROVIDER', 'REPLAY_VISION_OAI_BASE_URL', 'REPLAY_VISION_OAI_MODEL', 'REPLAY_VISION_OAI_SELF_HOSTED', 'REPLAY_VISION_ALLOW_EXTERNAL']) delete process.env[k]
})
