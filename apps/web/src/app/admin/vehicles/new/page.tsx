"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  adminCreateVehicle,
  adminListAdapterTypes,
  AdapterTypesResponse,
  ApiError,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  EMPTY_VEHICLE_FORM,
  FormErrors,
  toCreateInput,
  validateSection,
  VehicleFormFields,
  VehicleFormValues,
} from "@/components/admin/VehicleForm";

/**
 * c15 P3 — /admin/vehicles/new: 3-step create wizard.
 *   1 基本    vehicleId / displayName / vehicleType / vendor / serial
 *   2 硬體    adapter / platform / camera / audio / limits / capabilities
 *   3 確認    summary → POST → redirect to detail (?created=1 auto-opens the
 *            deploy-package download dialog there)
 * One step per screen on all viewports (mobile-first); progress bar on top.
 */

const STEPS = ["基本資料", "硬體 & Adapter", "確認建立"] as const;

const API_ERROR_MESSAGES: Record<string, string> = {
  vehicle_id_taken: "這個 Vehicle ID 已存在，請換一個",
  unknown_adapter_type: "Adapter 無效，請重新選擇",
  adapter_vehicle_type_mismatch: "Adapter 與載具類型不相容",
  validation_error: "欄位驗證失敗，請檢查輸入",
};

export default function NewVehiclePage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<VehicleFormValues>(EMPTY_VEHICLE_FORM);
  const [errors, setErrors] = useState<FormErrors>({});
  const [registry, setRegistry] = useState<AdapterTypesResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  useEffect(() => {
    adminListAdapterTypes()
      .then(setRegistry)
      .catch(() => setApiError("adapter registry 載入失敗"));
  }, []);

  function onChange(patch: Partial<VehicleFormValues>) {
    setValues((v) => ({ ...v, ...patch }));
    // Clear errors for edited fields as the admin types.
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key as keyof VehicleFormValues];
      return next;
    });
  }

  function next() {
    const section = step === 0 ? "basic" : "hardware";
    const errs = validateSection(values, section);
    // Adapter ↔ vehicleType pairing check on the hardware step.
    if (section === "hardware" && registry) {
      const adapter = registry.adapterTypes.find((a) => a.id === values.adapterType);
      if (adapter && !adapter.vehicleTypes.includes(values.vehicleType)) {
        errs.adapterType = `此 adapter 不支援 ${values.vehicleType}`;
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length === 0) setStep((s) => s + 1);
  }

  async function onCreate() {
    setSubmitting(true);
    setApiError(null);
    try {
      const created = await adminCreateVehicle(toCreateInput(values));
      router.push(
        `/admin/vehicles/${encodeURIComponent(created.vehicleId)}?created=1`,
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "network_error";
      setApiError(API_ERROR_MESSAGES[code] ?? `建立失敗：${code}`);
      if (code === "vehicle_id_taken") setStep(0);
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <section className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">加新車</h1>
        <p className="mt-2 text-sm text-neutral-400">
          三步驟完成載具上架，建立後可直接下載部署套件
        </p>
      </section>

      {/* ── Progress ── */}
      <ol className="flex items-center gap-2 mb-6" data-testid="wizard-progress">
        {STEPS.map((label, i) => (
          <li key={label} className="flex-1">
            <div
              className={`h-1.5 rounded-full mb-2 transition-colors ${
                i <= step ? "bg-[var(--accent-blue)]" : "bg-white/10"
              }`}
            />
            <span
              className={`text-xs ${
                i === step ? "text-neutral-200 font-medium" : "text-neutral-600"
              }`}
            >
              {i + 1}. {label}
            </span>
          </li>
        ))}
      </ol>

      {apiError && (
        <p className="text-sm text-[var(--accent-red)] mb-4" data-testid="wizard-error">
          {apiError}
        </p>
      )}

      <Card className="p-5 sm:p-6">
        {step < 2 ? (
          registry === null && step === 1 ? (
            <p className="text-sm text-neutral-500">載入 adapter registry…</p>
          ) : (
            <VehicleFormFields
              section={step === 0 ? "basic" : "hardware"}
              values={values}
              errors={errors}
              onChange={onChange}
              adapterTypes={registry?.adapterTypes ?? []}
              allCapabilities={registry?.allCapabilities ?? []}
              mode="create"
            />
          )
        ) : (
          <Summary values={values} />
        )}

        {/* ── Nav ── */}
        <div className="mt-6 flex gap-3">
          {step > 0 && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => setStep((s) => s - 1)}
              disabled={submitting}
              data-testid="wizard-back"
            >
              ← 上一步
            </Button>
          )}
          <div className="ml-auto">
            {step < 2 ? (
              <Button size="md" onClick={next} data-testid="wizard-next">
                下一步 →
              </Button>
            ) : (
              <Button
                size="md"
                onClick={onCreate}
                disabled={submitting}
                data-testid="wizard-create"
              >
                {submitting ? "建立中…" : "建立車輛"}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function Summary({ values }: { values: VehicleFormValues }) {
  const rows: Array<[string, string]> = [
    ["Vehicle ID", values.vehicleId],
    ["顯示名稱", values.displayName],
    ["載具類型", values.vehicleType],
    ["Vendor", values.vendor || "—"],
    ["序號", values.serialNumber || "—"],
    ["Adapter", values.adapterType],
    ["Platform", values.platformId],
    ["Camera Profile", values.cameraProfileId],
    ["Audio Profile", values.audioProfileId],
    ["最大線速度", `${values.maxLinearMs} m/s`],
    ["最大角速度", `${values.maxAngularRads} rad/s`],
    ["Capabilities", values.declaredCapabilities.join(", ") || "—"],
  ];
  return (
    <dl className="space-y-0 divide-y divide-[var(--border-subtle)]" data-testid="wizard-summary">
      {rows.map(([label, value]) => (
        <div key={label} className="flex gap-4 py-2.5 text-sm">
          <dt className="w-32 shrink-0 text-neutral-500">{label}</dt>
          <dd className="min-w-0 break-words font-mono text-neutral-200">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
