import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import {
  encryptSecret,
  decryptSecret,
  isSecretEncryptionEnabled,
} from "@/lib/secret-encryption";

/**
 * c15 P4 — AES-256-GCM 2FA secret encryption lib (2FA UI ships later; the
 * at-rest crypto must be correct now so stored secrets never need migrating).
 */

const ENV_VAR = "TWO_FACTOR_ENCRYPTION_KEY";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_VAR];
});

afterEach(() => {
  if (saved === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = saved;
});

describe("secret-encryption (c15 P4)", () => {
  it("round-trips a TOTP-style secret with a valid 32-byte hex key", () => {
    process.env[ENV_VAR] = randomBytes(32).toString("hex");
    expect(isSecretEncryptionEnabled()).toBe(true);

    const secret = "JBSWY3DPEHPK3PXP";
    const encoded = encryptSecret(secret);
    expect(encoded).not.toContain(secret);
    expect(decryptSecret(encoded)).toBe(secret);

    // Random IV — same plaintext, different ciphertext.
    expect(encryptSecret(secret)).not.toBe(encoded);
  });

  it("detects tampering via the GCM auth tag", () => {
    process.env[ENV_VAR] = randomBytes(32).toString("hex");
    const encoded = encryptSecret("JBSWY3DPEHPK3PXP");
    const buf = Buffer.from(encoded, "base64");
    buf[buf.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => decryptSecret(buf.toString("base64"))).toThrow();
  });

  it("disables (not crashes) when the key is missing or malformed", () => {
    delete process.env[ENV_VAR];
    expect(isSecretEncryptionEnabled()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/not configured/);

    process.env[ENV_VAR] = "too-short";
    expect(isSecretEncryptionEnabled()).toBe(false);
  });
});
