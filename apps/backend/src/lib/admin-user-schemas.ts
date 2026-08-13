import { z } from "zod";
import { Role } from "@prisma/client";

/**
 * c15 P4 — Zod input schemas for the admin user CRUD API.
 * Same convention as admin-vehicle-schemas: .strict() so unknown / immutable
 * fields are rejected with 422 instead of silently ignored.
 */

const roleSchema = z.nativeEnum(Role);

const emailSchema = z.string().trim().toLowerCase().email().max(254);

/** Raw password input — the real policy runs in validatePasswordPolicy. */
const passwordInput = z.string().min(1).max(128);

export const createUserSchema = z
  .object({
    email: emailSchema,
    displayName: z.string().trim().min(1).max(120),
    role: roleSchema,
    /** email = send invite link / manual_password = admin sets temp password */
    inviteMethod: z.enum(["email", "manual_password"]),
    /** Required iff inviteMethod=manual_password. */
    manualPassword: passwordInput.optional(),
    /** Optional wizard shortcut: clone another user's vehicle permissions. */
    copyPermissionsFromUserId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.inviteMethod === "manual_password" && !val.manualPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manualPassword"],
        message: "required when inviteMethod=manual_password",
      });
    }
    if (val.inviteMethod === "email" && val.manualPassword !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manualPassword"],
        message: "must be omitted when inviteMethod=email",
      });
    }
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;

/**
 * Partial update. Immutable / flow-owned fields (id / passwordHash /
 * inviteToken / twoFactor* / failedLoginCount / …) are intentionally absent —
 * strict() rejects them. archivedAt only accepts null (= restore); archiving
 * goes through DELETE so the last-admin guard is centralised.
 */
export const updateUserSchema = z
  .object({
    email: emailSchema,
    displayName: z.string().trim().min(1).max(120),
    role: roleSchema,
    archivedAt: z.null(),
  })
  .partial()
  .strict();

export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const resetPasswordSchema = z
  .object({
    method: z.enum(["invite_link", "manual"]),
    manualPassword: passwordInput.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.method === "manual" && !val.manualPassword) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manualPassword"],
        message: "required when method=manual",
      });
    }
    if (val.method === "invite_link" && val.manualPassword !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["manualPassword"],
        message: "must be omitted when method=invite_link",
      });
    }
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;

/** Public /auth/accept-invite body (not an admin endpoint). */
export const acceptInviteSchema = z
  .object({
    inviteToken: z.string().min(20).max(128),
    newPassword: passwordInput,
  })
  .strict();

export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;
