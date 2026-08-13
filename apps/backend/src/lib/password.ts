import { randomBytes } from "crypto";
import {
  hashPassword as bcryptHashPassword,
  comparePassword,
} from "@/lib/auth";

/**
 * c15 P4 — password security layer for the admin user CRUD.
 *
 * Hashing delegates to the existing bcrypt helpers in @/lib/auth (bcryptjs,
 * cost 12 via BCRYPT_ROUNDS default) so login / seed / user CRUD all share one
 * implementation. This module adds:
 *   - the server-side password policy (per c15 spec §Password 安全層)
 *   - invite-token generation for the invite-link onboarding flow
 */

export const PASSWORD_MIN_LENGTH = 12;

/**
 * Hard-coded top-100 weak/leaked password list (lowercased). Deliberately
 * in-code — no third-party breach API call from the backend (per P4 scope).
 * The ≥12-char rule already rejects most of these; the list catches the long
 * ones and stays authoritative if the length rule ever loosens.
 */
const COMMON_WEAK_PASSWORDS = new Set<string>([
  "123456", "password", "12345678", "qwerty", "123456789",
  "12345", "1234", "111111", "1234567", "dragon",
  "123123", "baseball", "abc123", "football", "monkey",
  "letmein", "shadow", "master", "666666", "qwertyuiop",
  "123321", "mustang", "1234567890", "michael", "654321",
  "superman", "1qaz2wsx", "7777777", "121212", "000000",
  "qazwsx", "123qwe", "killer", "trustno1", "jordan",
  "jennifer", "zxcvbnm", "asdfgh", "hunter", "buster",
  "soccer", "harley", "batman", "andrew", "tigger",
  "sunshine", "iloveyou", "2000", "charlie", "robert",
  "thomas", "hockey", "ranger", "daniel", "starwars",
  "klaster", "112233", "george", "computer", "michelle",
  "jessica", "pepper", "1111", "zxcvbn", "555555",
  "11111111", "131313", "freedom", "777777", "pass",
  "maggie", "159753", "aaaaaa", "ginger", "princess",
  "joshua", "cheese", "amanda", "summer", "love",
  "ashley", "nicole", "chelsea", "biteme", "matthew",
  "access", "yankees", "987654321", "dallas", "austin",
  "thunder", "taylor", "matrix", "password1", "password123",
  "password1234", "passw0rd", "letmein123", "welcome1",
  "admin123", "administrator", "changeme", "qwerty123456",
  "1234567890ab", "iloveyou1234", "abcdefg12345", "password12345",
]);

export interface PasswordPolicyResult {
  ok: boolean;
  /** 'too_short' | 'missing_letter' | 'missing_digit' | 'common_password' */
  reason?: string;
}

/**
 * Server-side password policy (per c15 SEC expert input):
 *   ≥ 12 chars, contains at least one letter AND one digit,
 *   not in the common weak-password list.
 */
export function validatePasswordPolicy(plain: string): PasswordPolicyResult {
  if (plain.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: "too_short" };
  }
  if (!/[a-zA-Z]/.test(plain)) {
    return { ok: false, reason: "missing_letter" };
  }
  if (!/[0-9]/.test(plain)) {
    return { ok: false, reason: "missing_digit" };
  }
  if (COMMON_WEAK_PASSWORDS.has(plain.toLowerCase())) {
    return { ok: false, reason: "common_password" };
  }
  return { ok: true };
}

/** bcrypt hash (cost 12 default via BCRYPT_ROUNDS). Client never sees hashes. */
export function hashPassword(plain: string): Promise<string> {
  return bcryptHashPassword(plain);
}

/** Constant-time bcrypt verify. */
export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return comparePassword(plain, hash);
}

/**
 * 256-bit random invite token, base64url (43 chars, URL-safe).
 * Stored on User.inviteToken (unique) and embedded in the invite link.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}
