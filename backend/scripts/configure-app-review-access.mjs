#!/usr/bin/env node

import {
  createHmac,
  randomBytes,
  randomInt,
} from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  chmod,
  chown,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { parse } from 'dotenv';

const REVIEW_PHONE = '10000000000';

function usage() {
  console.error(
    'Usage: node scripts/configure-app-review-access.mjs ' +
      '--env /absolute/path/to/.env --output /absolute/path/to/credential.txt'
  );
  process.exit(2);
}

function option(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) usage();
  return value;
}

function replaceEnvValue(source, name, value) {
  const line = `${name}=${value}`;
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (pattern.test(source)) return source.replace(pattern, line);
  const separator = source.endsWith('\n') ? '' : '\n';
  return `${source}${separator}${line}\n`;
}

const envPath = option('--env');
const outputPath = option('--output');
if (!isAbsolute(envPath) || !isAbsolute(outputPath)) usage();
if (dirname(envPath) === dirname(outputPath)) {
  throw new Error('Credential output must be stored outside the repository');
}

const envStat = await stat(envPath);
const envSource = await readFile(envPath, 'utf8');
const parsed = parse(envSource);
const jwtSecret = parsed.JWT_SECRET ?? '';
if (Buffer.byteLength(jwtSecret, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be at least 32 bytes');
}

const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
const codeHmac = createHmac('sha256', jwtSecret)
  .update(`photospeak:app-review:${REVIEW_PHONE}:${code}`, 'utf8')
  .digest('hex');

const credentialText = [
  'PhotoSpeak App Review credential',
  `phone=${REVIEW_PHONE}`,
  `code=${code}`,
  'Keep this file private. Disable APP_REVIEW_ACCESS_ENABLED after review.',
  '',
].join('\n');
await writeFile(outputPath, credentialText, { mode: 0o600, flag: 'wx' });

let updated = replaceEnvValue(
  envSource,
  'APP_REVIEW_ACCESS_ENABLED',
  'true'
);
updated = replaceEnvValue(updated, 'APP_REVIEW_PHONE', REVIEW_PHONE);
updated = replaceEnvValue(updated, 'APP_REVIEW_CODE_HMAC', codeHmac);

const temporaryPath = join(
  dirname(envPath),
  `.env.app-review-${process.pid}-${randomBytes(6).toString('hex')}`
);
try {
  await writeFile(temporaryPath, updated, {
    mode: envStat.mode & 0o777,
    flag: 'wx',
  });
  await chmod(temporaryPath, envStat.mode & 0o777);
  await chown(temporaryPath, envStat.uid, envStat.gid);
  await rename(temporaryPath, envPath);
} catch (error) {
  await unlink(temporaryPath).catch(() => {});
  throw error;
}

console.log(`Configured the revocable App Review login.`);
console.log(`Credential written with mode 0600 to: ${outputPath}`);
