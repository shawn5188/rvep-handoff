import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * c15 P4 — application-level AES-256-GCM at-rest encryption for 2FA secrets
 * (per c15-p1-migration-design §6 fork 6: Node crypto, no pgcrypto extension).
 *
 * Key: TWO_FACTOR_ENCRYPTION_KEY env — 32 bytes as 64 hex chars.
 * If unset/invalid the 2FA feature is DISABLED with a console warning
 * (never crashes the backend). Callers must gate writes on
 * isSecretEncryptionEnabled(); User.twoFactorSecret simply stays null.
 *
 * Wire format: base64( iv[12] || authTag[16] || ciphertext ).
 * 2FA enrol/verify UI ships in a later phase — P4 only lands this lib.
 */

const ENV_VAR = "TWO_FACTOR_ENCRYPTION_KEY";
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV per NIST SP 800-38D recommendation
const TAG_LENGTH = 16;

let warnedDisabled = false;

function readKey(): Buffer | null {
  const raw = process.env[ENV_VAR];
  if (!raw) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn(
        `[secret-encryption] ${ENV_VAR} not set — 2FA secret storage disabled. ` +
          `Generate one with: openssl rand -hex 32`,
      );
    }
    return null;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      console.warn(
        `[secret-encryption] ${ENV_VAR} must be 64 hex chars (32 bytes) — ` +
          `2FA secret storage disabled.`,
      );
    }
    return null;
  }
  return Buffer.from(raw, "hex");
}

/** True when a valid key is configured and 2FA secrets can be stored. */
export function isSecretEncryptionEnabled(): boolean {
  return readKey() !== null;
}

/** Encrypt a plaintext secret → base64(iv || authTag || ciphertext). */
export function encryptSecret(plain: string): string {
  const key = readKey();
  if (!key) {
    throw new Error(
      `[secret-encryption] cannot encrypt: ${ENV_VAR} not configured`,
    );
  }
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Decrypt base64(iv || authTag || ciphertext) → plaintext. Throws on tamper. */
export function decryptSecret(encoded: string): string {
  const key = readKey();
  if (!key) {
    throw new Error(
      `[secret-encryption] cannot decrypt: ${ENV_VAR} not configured`,
    );
  }
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("[secret-encryption] encoded secret too short");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
