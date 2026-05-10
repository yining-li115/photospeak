/**
 * Aliyun dypnsapi (短信认证) wrapper. Verification code lifecycle —
 * generation, 5-minute expiry, 60s same-number throttle, one-shot
 * consumption — is owned by Aliyun. We never store codes ourselves.
 */
import DypnsapiPkg, {
  CheckSmsVerifyCodeRequest,
  SendSmsVerifyCodeRequest,
} from '@alicloud/dypnsapi20170525';
import { Config } from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';

// CJS-from-ESM interop. The dypnsapi package's actual class can be at
// the top level, on `.default`, or (since some recent v2 builds) on
// `.default.default`. Walk down the `default` chain until we find a
// function — that's the class.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveDypnsapiCtor(pkg: any): any {
  let cur = pkg;
  for (let i = 0; i < 4 && cur; i++) {
    if (typeof cur === 'function') return cur;
    if (cur.default === undefined) break;
    cur = cur.default;
  }
  return cur;
}

type DypnsapiClient = InstanceType<typeof DypnsapiPkg>;
const DypnsapiCtor = resolveDypnsapiCtor(DypnsapiPkg) as typeof DypnsapiPkg;

let cachedClient: DypnsapiClient | null = null;

function getClient(): DypnsapiClient {
  if (cachedClient) return cachedClient;
  const id = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const secret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  if (!id || !secret) {
    throw new Error(
      'ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET are required for SMS'
    );
  }
  // If the unwrap above failed (package structure changed yet again),
  // dump enough of the export shape to identify where the class moved.
  if (typeof DypnsapiCtor !== 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pkg = DypnsapiPkg as any;
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'sms-ctor-resolve-failed',
        topLevelType: typeof pkg,
        topLevelKeys:
          pkg && typeof pkg === 'object' ? Object.keys(pkg).slice(0, 20) : [],
        defaultType: typeof pkg?.default,
        defaultKeys:
          pkg?.default && typeof pkg.default === 'object'
            ? Object.keys(pkg.default).slice(0, 20)
            : [],
        defaultDefaultType: typeof pkg?.default?.default,
      })
    );
    throw new Error('Failed to resolve Dypnsapi class — see logs');
  }
  const config = new Config({ accessKeyId: id, accessKeySecret: secret });
  config.endpoint = 'dypnsapi.aliyuncs.com';
  cachedClient = new DypnsapiCtor(config);
  return cachedClient;
}

export class SmsThrottledError extends Error {
  constructor() {
    super('Sending too frequently — try again shortly');
    this.name = 'SmsThrottledError';
  }
}

export class SmsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmsUnavailableError';
  }
}

/**
 * Ask Aliyun to generate + send a 6-digit code to the phone number.
 * Returns the upstream `bizId` (handy for support tickets); the code
 * itself never enters our process.
 */
export async function sendVerifyCode(phoneNumber: string): Promise<{
  bizId?: string;
}> {
  const client = getClient();
  const request = new SendSmsVerifyCodeRequest({
    phoneNumber,
    signName: process.env.ALIYUN_SMS_SIGN_NAME,
    templateCode: process.env.ALIYUN_SMS_TEMPLATE_CODE,
    templateParam: '{"code":"##code##","min":"5"}',
    codeType: 1,
    codeLength: 6,
    validTime: 300,
    interval: 60,
    duplicatePolicy: 1,
  });

  // Log what methods the resolved client actually has — if v2 of the
  // SDK renamed sendSmsVerifyCodeWithOptions, this surfaces the new
  // name without another guess-and-deploy round-trip.
  if (typeof (client as unknown as { sendSmsVerifyCodeWithOptions?: unknown })
    .sendSmsVerifyCodeWithOptions !== 'function') {
    const proto = Object.getPrototypeOf(client) ?? {};
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'sms-client-method-missing',
        clientCtorName: client?.constructor?.name ?? 'unknown',
        ownKeys: Object.keys(client as object).slice(0, 30),
        protoKeys: Object.getOwnPropertyNames(proto).slice(0, 50),
      })
    );
  }

  let resp;
  try {
    resp = await client.sendSmsVerifyCodeWithOptions(
      request,
      new RuntimeOptions({})
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'sms-upstream-error',
        phase: 'send',
        errName: err instanceof Error ? err.name : typeof err,
        msg: msg.slice(0, 500),
        stack:
          err instanceof Error
            ? (err.stack ?? '').split('\n').slice(0, 5).join(' | ')
            : '',
      })
    );
    if (/INTERVAL|FREQUENCY|BUSINESS_LIMIT/i.test(msg)) {
      throw new SmsThrottledError();
    }
    throw new SmsUnavailableError(msg);
  }

  if (!resp?.body || resp.body.code !== 'OK') {
    const code = resp?.body?.code ?? 'unknown';
    // Dump everything we can about the response shape + the env vars
    // we depend on. "UNKNOWN" / "UNKNOWN" out of dypnsapi v2 has shown
    // up in the wild and is hard to diagnose without seeing both the
    // raw response and which sign/template were sent in.
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'sms-upstream-non-ok',
        phase: 'send',
        code,
        message: resp?.body?.message ?? '',
        respKeys: resp ? Object.keys(resp).slice(0, 20) : [],
        bodyKeys:
          resp?.body && typeof resp.body === 'object'
            ? Object.keys(resp.body).slice(0, 20)
            : [],
        // Stringify with a length cap so we can see body shape but not
        // accidentally leak megabytes if the SDK packs raw HTTP into it.
        bodyJson: (() => {
          try {
            const s = JSON.stringify(resp?.body);
            return s.length > 1500 ? s.slice(0, 1500) + '…' : s;
          } catch {
            return '<unserializable>';
          }
        })(),
        statusCode:
          (resp as unknown as { statusCode?: number })?.statusCode ?? null,
        headers:
          (resp as unknown as { headers?: Record<string, unknown> })?.headers
            ? Object.keys(
                (resp as unknown as { headers: Record<string, unknown> }).headers
              ).slice(0, 20)
            : [],
        // Env presence (truthy/falsy only — never log values).
        envPresent: {
          ALIBABA_CLOUD_ACCESS_KEY_ID: !!process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
          ALIBABA_CLOUD_ACCESS_KEY_SECRET:
            !!process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
          ALIYUN_SMS_SIGN_NAME: !!process.env.ALIYUN_SMS_SIGN_NAME,
          ALIYUN_SMS_TEMPLATE_CODE: !!process.env.ALIYUN_SMS_TEMPLATE_CODE,
        },
      })
    );
    if (/INTERVAL|FREQUENCY|BUSINESS_LIMIT/i.test(code)) {
      throw new SmsThrottledError();
    }
    throw new SmsUnavailableError(
      `Aliyun SMS send failed: ${code} ${resp?.body?.message ?? ''}`
    );
  }
  return { bizId: resp.body.model?.bizId };
}

/**
 * Validate a code the user typed. Returns true only when Aliyun
 * reports verifyResult === 'PASS'. Wrong / expired codes return
 * false; transport errors throw.
 */
export async function checkVerifyCode(
  phoneNumber: string,
  verifyCode: string
): Promise<boolean> {
  const client = getClient();
  const request = new CheckSmsVerifyCodeRequest({
    phoneNumber,
    verifyCode,
    countryCode: '86',
  });

  let resp;
  try {
    resp = await client.checkSmsVerifyCodeWithOptions(
      request,
      new RuntimeOptions({})
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ValidateFail|VALIDATE/i.test(msg)) return false;
    throw new SmsUnavailableError(msg);
  }
  if (!resp?.body || resp.body.code !== 'OK') return false;
  return resp.body.model?.verifyResult === 'PASS';
}
