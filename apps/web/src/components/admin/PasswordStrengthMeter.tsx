"use client";

/**
 * c15 P4 — realtime password strength meter + client-side policy mirror.
 *
 * The backend (apps/backend/src/lib/password.ts) is the source of truth and
 * re-validates every request; this module re-implements the same policy
 * client-side so admins / invitees get instant feedback without an API call:
 *   ≥ 12 chars, at least one letter AND one digit, not a common weak password.
 */

export const PASSWORD_MIN_LENGTH = 12;

/** Client-side subset of the backend weak list (backend list is authoritative). */
const COMMON_WEAK_PASSWORDS = new Set<string>([
  "123456", "password", "12345678", "qwerty", "123456789",
  "1234567890", "111111", "abc123", "letmein", "iloveyou",
  "monkey", "dragon", "sunshine", "princess", "football",
  "trustno1", "superman", "1qaz2wsx", "qwertyuiop", "starwars",
  "password1", "password123", "password1234", "passw0rd", "letmein123",
  "welcome1", "admin123", "administrator", "changeme", "qwerty123456",
  "1234567890ab", "iloveyou1234", "abcdefg12345", "password12345",
]);

export interface PasswordPolicyResult {
  ok: boolean;
  /** 'too_short' | 'missing_letter' | 'missing_digit' | 'common_password' */
  reason?: string;
}

export function checkPasswordPolicy(plain: string): PasswordPolicyResult {
  if (plain.length < PASSWORD_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (!/[a-zA-Z]/.test(plain)) return { ok: false, reason: "missing_letter" };
  if (!/[0-9]/.test(plain)) return { ok: false, reason: "missing_digit" };
  if (COMMON_WEAK_PASSWORDS.has(plain.toLowerCase())) {
    return { ok: false, reason: "common_password" };
  }
  return { ok: true };
}

export const POLICY_REASON_MESSAGES: Record<string, string> = {
  too_short: `至少 ${PASSWORD_MIN_LENGTH} 個字元`,
  missing_letter: "需包含英文字母",
  missing_digit: "需包含數字",
  common_password: "太常見的密碼，請換一組",
};

/** 0 (empty) … 4 (strong). Policy-passing passwords score at least 2. */
export function passwordScore(pw: string): number {
  if (!pw) return 0;
  if (!checkPasswordPolicy(pw).ok) return 1;
  let score = 2;
  if (pw.length >= 16) score += 1;
  const classes =
    Number(/[a-z]/.test(pw)) +
    Number(/[A-Z]/.test(pw)) +
    Number(/[0-9]/.test(pw)) +
    Number(/[^a-zA-Z0-9]/.test(pw));
  if (classes >= 3) score += 1;
  return Math.min(score, 4);
}

const SCORE_META: Array<{ label: string; bar: string; text: string }> = [
  { label: "", bar: "bg-white/10", text: "text-neutral-600" },
  { label: "太弱", bar: "bg-[var(--accent-red)]", text: "text-[var(--accent-red)]" },
  { label: "可用", bar: "bg-amber-400", text: "text-amber-300" },
  { label: "不錯", bar: "bg-emerald-400", text: "text-emerald-300" },
  { label: "很強", bar: "bg-emerald-300", text: "text-emerald-200" },
];

export function PasswordStrengthMeter({ password }: { password: string }) {
  const score = passwordScore(password);
  const meta = SCORE_META[score];
  const policy = checkPasswordPolicy(password);

  return (
    <div className="mt-2" data-testid="password-strength">
      <div className="flex gap-1.5">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              i <= score ? meta.bar : "bg-white/10"
            }`}
          />
        ))}
      </div>
      <p className={`mt-1.5 text-xs ${meta.text}`}>
        {password.length === 0
          ? `至少 ${PASSWORD_MIN_LENGTH} 字元，含英文字母 + 數字`
          : policy.ok
            ? meta.label
            : POLICY_REASON_MESSAGES[policy.reason ?? ""] ?? "不符合密碼規則"}
      </p>
    </div>
  );
}
