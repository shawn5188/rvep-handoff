"use client";

import { z } from "zod";
import type {
  AdapterTypeInfo,
  CreateVehicleInput,
  VehicleTypeName,
} from "@/lib/api-client";

/**
 * c15 P3 — shared vehicle form fields, reused by:
 *   /admin/vehicles/new     (wizard: section="basic" then section="hardware")
 *   /admin/vehicles/[id]    (overview tab inline edit: both sections)
 *
 * Controlled component — parent owns values / errors state. Client-side Zod
 * validation mirrors the backend schema (backend re-validates regardless).
 */

export const VEHICLE_TYPES: VehicleTypeName[] = [
  "WHEELED",
  "QUADRUPED",
  "WHEELED_QUADRUPED",
  "RC_CAR",
  "DRONE",
  "CUSTOM",
];

export interface VehicleFormValues {
  vehicleId: string;
  displayName: string;
  vehicleType: VehicleTypeName;
  vendor: string;
  serialNumber: string;
  adapterType: string;
  platformId: string;
  cameraProfileId: string;
  audioProfileId: string;
  maxLinearMs: string; // string in form state; parsed on submit
  maxAngularRads: string;
  declaredCapabilities: string[];
}

export const EMPTY_VEHICLE_FORM: VehicleFormValues = {
  vehicleId: "",
  displayName: "",
  vehicleType: "WHEELED",
  vendor: "",
  serialNumber: "",
  adapterType: "",
  platformId: "",
  cameraProfileId: "",
  audioProfileId: "",
  maxLinearMs: "0.5",
  maxAngularRads: "1.0",
  declaredCapabilities: [],
};

const numberString = (max: number) =>
  z
    .string()
    .refine((s) => s.trim() !== "" && !Number.isNaN(Number(s)), "必須是數字")
    .refine((s) => Number(s) > 0 && Number(s) <= max, `必須介於 0 和 ${max} 之間`);

export const basicSectionSchema = z.object({
  vehicleId: z
    .string()
    .min(3, "至少 3 字元")
    .max(64, "最多 64 字元")
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "只能用小寫英數字、- 和 _"),
  displayName: z.string().min(1, "必填").max(120),
  vehicleType: z.enum(VEHICLE_TYPES as [VehicleTypeName, ...VehicleTypeName[]]),
  vendor: z.string().max(120),
  serialNumber: z.string().max(120),
});

export const hardwareSectionSchema = z.object({
  adapterType: z.string().min(1, "必選"),
  platformId: z.string().min(1, "必填").max(120),
  cameraProfileId: z.string().min(1, "必填").max(120),
  audioProfileId: z.string().min(1, "必填").max(120),
  maxLinearMs: numberString(20),
  maxAngularRads: numberString(12.6),
});

export type FormErrors = Partial<Record<keyof VehicleFormValues, string>>;

export function validateSection(
  values: VehicleFormValues,
  section: "basic" | "hardware",
): FormErrors {
  const schema = section === "basic" ? basicSectionSchema : hardwareSectionSchema;
  const result = schema.safeParse(values);
  if (result.success) return {};
  const errors: FormErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as keyof VehicleFormValues;
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

/** Convert validated form values to the POST /admin/vehicles payload. */
export function toCreateInput(values: VehicleFormValues): CreateVehicleInput {
  return {
    vehicleId: values.vehicleId.trim(),
    displayName: values.displayName.trim(),
    vehicleType: values.vehicleType,
    adapterType: values.adapterType,
    platformId: values.platformId.trim(),
    cameraProfileId: values.cameraProfileId.trim(),
    audioProfileId: values.audioProfileId.trim(),
    ...(values.vendor.trim() ? { vendor: values.vendor.trim() } : {}),
    ...(values.serialNumber.trim() ? { serialNumber: values.serialNumber.trim() } : {}),
    declaredCapabilities: values.declaredCapabilities,
    maxLinearMs: Number(values.maxLinearMs),
    maxAngularRads: Number(values.maxAngularRads),
  };
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export function VehicleFormFields({
  section,
  values,
  errors,
  onChange,
  adapterTypes,
  allCapabilities,
  mode,
}: {
  section: "basic" | "hardware";
  values: VehicleFormValues;
  errors: FormErrors;
  onChange: (patch: Partial<VehicleFormValues>) => void;
  adapterTypes: AdapterTypeInfo[];
  allCapabilities: string[];
  mode: "create" | "edit";
}) {
  if (section === "basic") {
    return (
      <div className="space-y-4">
        <TextField
          label="Vehicle ID"
          value={values.vehicleId}
          onChange={(v) => onChange({ vehicleId: v })}
          error={errors.vehicleId}
          placeholder="amr-02"
          disabled={mode === "edit"}
          hint={mode === "edit" ? "建立後不可修改" : "小寫英數字 + dash，建立後不可改"}
          testid="vf-vehicle-id"
        />
        <TextField
          label="顯示名稱"
          value={values.displayName}
          onChange={(v) => onChange({ displayName: v })}
          error={errors.displayName}
          placeholder="AMR-02"
          testid="vf-display-name"
        />
        <SelectField
          label="載具類型"
          value={values.vehicleType}
          onChange={(v) => onChange({ vehicleType: v as VehicleTypeName })}
          options={VEHICLE_TYPES.map((t) => ({ value: t, label: t }))}
          error={errors.vehicleType}
          testid="vf-vehicle-type"
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TextField
            label="Vendor（選填）"
            value={values.vendor}
            onChange={(v) => onChange({ vendor: v })}
            error={errors.vendor}
            placeholder="Wheeltec"
            testid="vf-vendor"
          />
          <TextField
            label="序號（選填）"
            value={values.serialNumber}
            onChange={(v) => onChange({ serialNumber: v })}
            error={errors.serialNumber}
            placeholder="WT-2026-001"
            testid="vf-serial"
          />
        </div>
      </div>
    );
  }

  const selectedAdapter = adapterTypes.find((a) => a.id === values.adapterType);
  const adapterMismatch =
    selectedAdapter && !selectedAdapter.vehicleTypes.includes(values.vehicleType);

  return (
    <div className="space-y-4">
      <SelectField
        label="Adapter"
        value={values.adapterType}
        onChange={(v) => {
          const adapter = adapterTypes.find((a) => a.id === v);
          onChange({
            adapterType: v,
            // Pre-check adapter defaults on switch (create flow only).
            ...(mode === "create" && adapter
              ? { declaredCapabilities: adapter.defaultCapabilities }
              : {}),
          });
        }}
        options={[
          { value: "", label: "— 選擇 adapter —" },
          ...adapterTypes.map((a) => ({ value: a.id, label: a.displayName })),
        ]}
        error={errors.adapterType}
        testid="vf-adapter"
      />
      {selectedAdapter && (
        <p className="text-xs text-neutral-500 -mt-2">{selectedAdapter.description}</p>
      )}
      {adapterMismatch && (
        <p className="text-xs text-amber-400" data-testid="vf-adapter-mismatch">
          ⚠ 此 adapter 不支援 {values.vehicleType}（支援：
          {selectedAdapter.vehicleTypes.join(" / ")}）
        </p>
      )}

      <TextField
        label="Platform ID"
        value={values.platformId}
        onChange={(v) => onChange({ platformId: v })}
        error={errors.platformId}
        placeholder="jetson-agx-orin"
        testid="vf-platform"
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TextField
          label="Camera Profile"
          value={values.cameraProfileId}
          onChange={(v) => onChange({ cameraProfileId: v })}
          error={errors.cameraProfileId}
          placeholder="zed-x-front-1080p60"
          testid="vf-camera"
        />
        <TextField
          label="Audio Profile"
          value={values.audioProfileId}
          onChange={(v) => onChange({ audioProfileId: v })}
          error={errors.audioProfileId}
          placeholder="jabra-speak2-55"
          testid="vf-audio"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <TextField
          label="最大線速度 (m/s)"
          value={values.maxLinearMs}
          onChange={(v) => onChange({ maxLinearMs: v })}
          error={errors.maxLinearMs}
          inputMode="decimal"
          testid="vf-max-linear"
        />
        <TextField
          label="最大角速度 (rad/s)"
          value={values.maxAngularRads}
          onChange={(v) => onChange({ maxAngularRads: v })}
          error={errors.maxAngularRads}
          inputMode="decimal"
          testid="vf-max-angular"
        />
      </div>

      <fieldset>
        <legend className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
          Declared Capabilities
        </legend>
        <div className="flex flex-wrap gap-2" data-testid="vf-capabilities">
          {capabilityChoices(allCapabilities, values.declaredCapabilities).map((cap) => {
            const checked = values.declaredCapabilities.includes(cap);
            return (
              <label
                key={cap}
                className={`inline-flex items-center gap-2 min-h-11 px-3 rounded-xl border cursor-pointer text-sm font-mono transition-colors ${
                  checked
                    ? "border-[var(--accent-blue)]/60 bg-[var(--accent-blue)]/10 text-neutral-100"
                    : "border-[var(--border-subtle)] text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-[var(--accent-blue)]"
                  checked={checked}
                  onChange={(e) =>
                    onChange({
                      declaredCapabilities: e.target.checked
                        ? [...values.declaredCapabilities, cap]
                        : values.declaredCapabilities.filter((c) => c !== cap),
                    })
                  }
                />
                {cap}
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}

function capabilityChoices(all: string[], selected: string[]): string[] {
  // Union keeps capabilities that exist on the vehicle but not in the registry.
  return [...new Set([...all, ...selected])].sort();
}

// ---------------------------------------------------------------------------
// Field primitives (44px+ touch targets per mobile-first rule)
// ---------------------------------------------------------------------------

const inputClass =
  "w-full rounded-xl bg-black/40 border px-4 h-12 text-base outline-none " +
  "focus:border-white/30 transition-colors placeholder-neutral-600 " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

function TextField({
  label,
  value,
  onChange,
  error,
  placeholder,
  disabled,
  hint,
  inputMode,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
  inputMode?: "decimal";
  testid: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        inputMode={inputMode}
        data-testid={testid}
        className={`${inputClass} ${
          error ? "border-[var(--accent-red)]/70" : "border-[var(--border-subtle)]"
        }`}
      />
      {error ? (
        <span className="block mt-1 text-xs text-[var(--accent-red)]">{error}</span>
      ) : hint ? (
        <span className="block mt-1 text-xs text-neutral-600">{hint}</span>
      ) : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  error?: string;
  testid: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testid}
        className={`${inputClass} appearance-none ${
          error ? "border-[var(--accent-red)]/70" : "border-[var(--border-subtle)]"
        }`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-neutral-900">
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <span className="block mt-1 text-xs text-[var(--accent-red)]">{error}</span>
      )}
    </label>
  );
}
