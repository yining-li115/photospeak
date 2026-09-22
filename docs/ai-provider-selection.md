# PhotoSpeak AI provider selection

Updated: 2026-09-22

PhotoSpeak treats AI vendors as infrastructure adapters. Mobile clients submit
domain requests (`session_analysis`, `follow_up`, `synthesize`) and never send a
model ID, system prompt, voice ID, or upstream credential. Provider selection,
fallbacks, budgets and output validation belong to the backend.

## Repository migration status

- The mobile API and backend business routes are provider-neutral; model IDs,
  prompts and credentials no longer come from the app.
- Ark vision/text can use the existing OpenAI-compatible text adapter after a
  staging evaluation and server configuration change.
- Volcengine TTS 2.0 now has a dedicated, bounded v3 HTTP Chunked adapter with
  mock protocol tests. Do not point the OpenAI-compatible speech adapter at
  that endpoint; the protocol and speech credentials are different. Real
  voice entitlement, latency and output quality still require staging tests.
- Production ASR now has a dedicated Volcengine Seed ASR 2.0 adapter behind
  PhotoSpeak's constrained relay. The provider key, endpoint and binary
  protocol stay on the backend; the 200-clip comparison below remains a
  release gate before sending production traffic.

## Recommended Volcengine stack

### Photo understanding and English coaching

Use Ark's OpenAI-compatible API at the backend. Model snapshot IDs change, so
copy the callable ID from Ark Console and keep it in server configuration.

| Model | PhotoSpeak role | Recommendation |
| --- | --- | --- |
| `doubao-seed-2-0-lite-260428` (or the latest Lite snapshot enabled in your console) | Image understanding, correction, polished monologue, normal follow-up | Cost-first default candidate. Keep the snapshot pinned after evaluation rather than following an alias silently. |
| `doubao-seed-2-0-pro-260215` | Low-confidence retry and offline quality evaluation | Quality fallback only; it is unnecessary for most one-photo requests. |
| `doubao-seed-2-0-mini-260428` (or the enabled Mini snapshot) | Short follow-up questions or controlled experiments | Lowest-cost option. Do not make it the default until bilingual teaching quality passes the evaluation set. |
| `doubao-seed-2-1-turbo-260628` | Current high-throughput multimodal A/B route | Test against Lite for photo accuracy and latency before promoting it; its public list price is materially higher. |
| `doubao-seed-2-1-pro-260628` | Current-generation quality route | Candidate for difficult/low-confidence examples and evaluation, not the initial default. |

Ark's public product page currently lists Seed 2.1 Turbo at approximately
¥3/¥15 and Seed 2.1 Pro at ¥6/¥30 per million input/output tokens. Seed 2.0
Lite/Mini remain useful cost-first candidates where the account exposes them.
Production prices, snapshot IDs and multimodal entitlements must be confirmed
in the console because the catalog and context tiers change.

For session analysis, disable deep thinking initially, use structured JSON
output, and cap the result at 12 polished sentences, 24 corrections and five
chunks. The app still validates the entire response before persisting or
synthesizing it.

### Realtime speech recognition

Use **Doubao big-model streaming speech recognition** rather than a general
multimodal LLM. It supports streaming input and sentence-level results and is a
closer replacement for the current Paraformer WebSocket experience.

The speech service uses a separate speech API key/resource authorization; an
Ark API key alone is not sufficient. For current ASR 2.0 accounts, choose
`volc.seedasr.sauc.duration` for low/variable traffic or
`volc.seedasr.sauc.concurrent` only after measuring sustained load. Older
console applications may expose legacy App Key/Access Key resources; do not
mix the two authentication modes. The recommended optimized duplex endpoint is
`wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`.

Before launch, benchmark at least 200 consented clips across:

- Chinese-accented English;
- English mixed with Chinese names and locations;
- quiet, street and café noise;
- short pauses and self-corrections;
- the full 70-second recording limit.

Measure word error rate, finalization latency, forced reconnects and punctuation
quality. Roll out only after the new provider meets the agreed gates.

### Speech synthesis

Use **Doubao large-model TTS 2.0** with MP3 or OGG Opus output. Do not store WAV
for regenerated playback. The current public English voices include Harmony,
Skye, Alvin and Brayan; start the listening test with Skye and Harmony rather
than choosing by description alone.

For the server adapter, use the V3 HTTP Chunked endpoint
`POST https://openspeech.bytedance.com/api/v3/tts/unidirectional`, resource
`seed-tts-2.0`, MP3 at 24 kHz, and the exact authorized `speaker` ID from the
speech console. The response is newline-delimited JSON: concatenate decoded
`code: 0` audio frames and require the `code: 20000000` terminal frame. Neither
this realtime TTS endpoint nor streaming ASR documents native idempotent replay
or result lookup, so both adapters must declare `none`; PhotoSpeak's durable
operation ledger fails closed after an ambiguous dispatch.

Voice, speed, format and provider IDs remain server policy. The mobile app only
sends text plus optional delivery guidance.

### Content safety

Volcengine's AIGC content-safety service can screen user text/images and model
output. It is a separate capability and commercial agreement, not a Seed model.
The provider gateway should expose a moderation hook and fail according to an
explicit policy; an unconfigured hook must never be reported as “content
approved.”

## Models that are not the primary fit

- `Doubao-Seed-RealtimeVoice`: useful for open-ended speech-to-speech agents,
  but it hides the intermediate transcript and makes PhotoSpeak's correction,
  replay and card pipeline harder to inspect.
- `Doubao-Seed-LiveInterpret`: intended for simultaneous translation, not
  English coaching.
- `Doubao-Seed-Vision`: usable, but Seed 2.0 Lite already covers the required
  image-plus-text workflow; benchmark before adding another route.
- Seedance, Seedream, Embedding, Music and Code models are not required by the
  current product.

## Credentials to provision

1. One production Ark API key for the multimodal Seed model, plus a separate
   staging key and budget.
2. One dedicated speech project/API key with only `seed-tts-2.0` and the chosen
   `volc.seedasr.sauc.*` resource. If your existing console issues the legacy
   App Key/Access Key pair instead, keep it in a separate adapter configuration.
3. Optional content-safety credentials after the policy and retention terms are
   approved.

Never place any of these credentials in `EXPO_PUBLIC_*` or a mobile binary.

## Release gates for a provider migration

- 200-clip ASR evaluation and 100-photo structured-output evaluation;
- schema-valid response rate of at least 99.5%;
- P95 analysis and synthesis latency budgets;
- provider error mapping that never returns the app's authentication 401;
- per-operation usage/cost ledger, budget alarms and a kill switch;
- privacy policy updated with provider, purpose, region and retention;
- staged rollout with 5%, 25%, 50%, then 100% traffic and automatic rollback.

## Official references

- Ark getting started and current model example:
  https://www.volcengine.com/docs/82379/1795150
- Current Ark product/pricing page:
  https://www.volcengine.com/product/ark
- Current model catalog (copy the callable snapshot ID from the console):
  https://www.volcengine.com/docs/82379/1330310
- Doubao model product matrix and prices:
  https://www.volcengine.com/product/doubao/
- Big-model streaming ASR overview:
  https://www.volcengine.com/docs/6561/1354871?lang=zh
- Speech resource IDs:
  https://www.volcengine.com/docs/6561/1476626?lang=en
- Large-model TTS capabilities:
  https://www.volcengine.com/docs/6561/1257543?lang=zh
- Current V3 HTTP Chunked TTS contract:
  https://www.volcengine.com/docs/6561/2528925?lang=zh
- Current optimized duplex ASR 2.0 contract:
  https://www.volcengine.com/docs/6561/2630027?lang=zh
- Current English voice list:
  https://www.volcengine.com/docs/6561/162929?lang=en
- AIGC content safety:
  https://www.volcengine.com/product/AIGC-content
