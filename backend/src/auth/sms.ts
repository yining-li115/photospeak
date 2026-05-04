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

// CJS-from-ESM interop: the dypnsapi package's default export is the
// client class, but Node's ESM-importing-CJS flow gives us the
// `module.exports` namespace object instead (with the class on
// `.default`). TypeScript's types lie about this, so unwrap manually.
type DypnsapiClient = InstanceType<typeof DypnsapiPkg>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DypnsapiCtor: typeof DypnsapiPkg =
  (DypnsapiPkg as any)?.default ?? DypnsapiPkg;

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

  let resp;
  try {
    resp = await client.sendSmsVerifyCodeWithOptions(
      request,
      new RuntimeOptions({})
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/INTERVAL|FREQUENCY|BUSINESS_LIMIT/i.test(msg)) {
      throw new SmsThrottledError();
    }
    throw new SmsUnavailableError(msg);
  }

  if (!resp?.body || resp.body.code !== 'OK') {
    const code = resp?.body?.code ?? 'unknown';
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
