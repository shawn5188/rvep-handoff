"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  adminArchiveVehicle,
  adminDownloadDeployPackage,
  adminGetVehicle,
  adminListAdapterTypes,
  adminMintVehicleToken,
  adminUpdateVehicle,
  AdminVehicleDetail,
  AdapterTypesResponse,
  ApiError,
  MintedVehicleToken,
  UpdateVehicleInput,
} from "@/lib/api-client";
import { saveBlob } from "@/lib/download";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/admin/StatusBadge";
import {
  FormErrors,
  validateSection,
  VehicleFormFields,
  VehicleFormValues,
} from "@/components/admin/VehicleForm";

/**
 * c15 P3 — /admin/vehicles/[id]: vehicle detail.
 * Header info card + 4 tabs (總覽 inline edit / 部署 / 使用歷史 / 能力) +
 * archive. Arriving with ?created=1 (from the create wizard) auto-opens the
 * deploy-package download dialog.
 */

const TABS = ["總覽", "部署", "使用歷史", "能力"] as const;
type Tab = (typeof TABS)[number];

export default function VehicleDetailPage() {
  return (
    <Suspense>
      <VehicleDetailInner />
    </Suspense>
  );
}

function VehicleDetailInner() {
  const params = useParams<{ id: string }>();
  const vehicleId = decodeURIComponent(params.id);
  const router = useRouter();
  const searchParams = useSearchParams();
  const justCreated = searchParams.get("created") === "1";

  const [detail, setDetail] = useState<AdminVehicleDetail | null>(null);
  const [registry, setRegistry] = useState<AdapterTypesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("總覽");
  const [busy, setBusy] = useState(false);
  const [showDownloadDialog, setShowDownloadDialog] = useState(justCreated);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [mintedToken, setMintedToken] = useState<MintedVehicleToken | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await adminGetVehicle(vehicleId);
      setDetail(d);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "network_error");
    }
  }, [vehicleId]);

  useEffect(() => {
    void load();
    adminListAdapterTypes().then(setRegistry).catch(() => undefined);
  }, [load]);

  async function onDownload() {
    setBusy(true);
    try {
      const blob = await adminDownloadDeployPackage(vehicleId);
      saveBlob(blob, `${vehicleId}-deploy.tar.gz`);
      setNotice("已下載部署套件（內含新簽 7 天 token）");
      setShowDownloadDialog(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "download_failed");
    } finally {
      setBusy(false);
    }
  }

  async function onMint(ttlSeconds: number, label: string) {
    setBusy(true);
    try {
      const minted = await adminMintVehicleToken(vehicleId, { ttlSeconds });
      setMintedToken(minted);
      setNotice(`已重簽 ${label} token`);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "token_failed");
    } finally {
      setBusy(false);
    }
  }

  async function onArchive() {
    setShowArchiveConfirm(false);
    setBusy(true);
    try {
      await adminArchiveVehicle(vehicleId);
      setNotice("已封存");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "archive_failed");
    } finally {
      setBusy(false);
    }
  }

  if (error && !detail) {
    return (
      <div className="max-w-4xl mx-auto">
        <p className="text-sm text-[var(--accent-red)]" data-testid="detail-error">
          {error === "vehicle_not_found" ? "找不到這台載具" : `錯誤：${error}`}
        </p>
        <Button
          variant="secondary"
          size="md"
          className="mt-4"
          onClick={() => router.push("/admin/vehicles")}
        >
          ← 回列表
        </Button>
      </div>
    );
  }

  if (!detail) {
    return <p className="max-w-4xl mx-auto text-sm text-neutral-500">載入中…</p>;
  }

  const archived = detail.archivedAt !== null;

  return (
    <div className="max-w-4xl mx-auto">
      {/* ── Header info card ── */}
      <Card className="p-5 sm:p-6 mb-6" data-testid="detail-header">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight font-mono">
                {detail.vehicleId}
              </h1>
              <StatusBadge status={detail.status} archived={archived} />
            </div>
            <p className="mt-1 text-neutral-300">{detail.displayName}</p>
            <p className="mt-2 text-xs text-neutral-500">
              {detail.vendor ? `${detail.vendor} · ` : ""}
              建立於 {new Date(detail.createdAt).toLocaleString("zh-TW", { hour12: false })}
              {detail.createdByEmail ? ` · by ${detail.createdByEmail}` : ""}
            </p>
          </div>
          {!archived && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => setShowArchiveConfirm(true)}
              disabled={busy}
              className="hover:text-[var(--accent-red)]"
              data-testid="detail-archive-btn"
            >
              封存
            </Button>
          )}
        </div>
      </Card>

      {error && (
        <p className="text-sm text-[var(--accent-red)] mb-4">錯誤：{error}</p>
      )}
      {notice && (
        <p
          className="text-sm text-emerald-300 mb-4 cursor-pointer"
          onClick={() => setNotice(null)}
          data-testid="detail-notice"
        >
          ✅ {notice}
        </p>
      )}

      {/* ── Tabs ── */}
      <div
        className="flex gap-1 mb-5 overflow-x-auto border-b border-[var(--border-subtle)]"
        role="tablist"
        data-testid="detail-tabs"
      >
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-11 px-4 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-[var(--accent-blue)] text-white font-medium"
                : "border-transparent text-neutral-500 hover:text-neutral-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "總覽" && (
        <OverviewTab
          detail={detail}
          registry={registry}
          disabled={archived || busy}
          onSaved={async (msg) => {
            setNotice(msg);
            await load();
          }}
          onError={setError}
        />
      )}
      {tab === "部署" && (
        <DeployTab
          busy={busy}
          archived={archived}
          mintedToken={mintedToken}
          onDownload={onDownload}
          onMint={onMint}
        />
      )}
      {tab === "使用歷史" && <HistoryTab detail={detail} />}
      {tab === "能力" && <CapabilitiesTab detail={detail} />}

      {/* ── Post-create download dialog ── */}
      {showDownloadDialog && (
        <Modal onClose={() => setShowDownloadDialog(false)} testid="download-dialog">
          <h2 className="text-lg font-semibold">🎉 {detail.vehicleId} 已建立</h2>
          <p className="mt-2 text-sm text-neutral-400">
            現在下載部署套件（env + README，含新簽 token），直接複製到車上即可啟用。
          </p>
          <div className="mt-5 flex gap-3 justify-end">
            <Button variant="ghost" size="md" onClick={() => setShowDownloadDialog(false)}>
              稍後再說
            </Button>
            <Button size="md" onClick={onDownload} disabled={busy} data-testid="dialog-download-btn">
              下載部署套件
            </Button>
          </div>
        </Modal>
      )}

      {/* ── Archive confirm ── */}
      {showArchiveConfirm && (
        <Modal onClose={() => setShowArchiveConfirm(false)} testid="archive-modal">
          <h2 className="text-lg font-semibold">封存 {detail.vehicleId}？</h2>
          <p className="mt-2 text-sm text-neutral-400">
            封存後不會出現在 Fleet / 預設列表，但歷史 session 與 audit 紀錄保留。
          </p>
          <div className="mt-5 flex gap-3 justify-end">
            <Button variant="ghost" size="md" onClick={() => setShowArchiveConfirm(false)}>
              取消
            </Button>
            <Button variant="danger" size="md" onClick={onArchive} data-testid="archive-confirm-btn">
              封存
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 總覽 — inline editable form (Save / Cancel)
// ---------------------------------------------------------------------------

function detailToForm(d: AdminVehicleDetail): VehicleFormValues {
  return {
    vehicleId: d.vehicleId,
    displayName: d.displayName,
    vehicleType: d.vehicleType,
    vendor: d.vendor ?? "",
    serialNumber: d.serialNumber ?? "",
    adapterType: d.adapterType,
    platformId: d.platformId,
    cameraProfileId: d.cameraProfileId,
    audioProfileId: d.audioProfileId,
    maxLinearMs: String(d.maxLinearMs),
    maxAngularRads: String(d.maxAngularRads),
    declaredCapabilities: d.declaredCapabilities,
  };
}

function buildPatch(
  original: AdminVehicleDetail,
  values: VehicleFormValues,
): UpdateVehicleInput {
  const patch: UpdateVehicleInput = {};
  if (values.displayName.trim() !== original.displayName)
    patch.displayName = values.displayName.trim();
  if (values.vehicleType !== original.vehicleType) patch.vehicleType = values.vehicleType;
  if (values.adapterType !== original.adapterType) patch.adapterType = values.adapterType;
  if (values.platformId.trim() !== original.platformId)
    patch.platformId = values.platformId.trim();
  if (values.cameraProfileId.trim() !== original.cameraProfileId)
    patch.cameraProfileId = values.cameraProfileId.trim();
  if (values.audioProfileId.trim() !== original.audioProfileId)
    patch.audioProfileId = values.audioProfileId.trim();
  const vendor = values.vendor.trim() || null;
  if (vendor !== original.vendor) patch.vendor = vendor;
  const serial = values.serialNumber.trim() || null;
  if (serial !== original.serialNumber) patch.serialNumber = serial;
  if (Number(values.maxLinearMs) !== original.maxLinearMs)
    patch.maxLinearMs = Number(values.maxLinearMs);
  if (Number(values.maxAngularRads) !== original.maxAngularRads)
    patch.maxAngularRads = Number(values.maxAngularRads);
  if (
    JSON.stringify(values.declaredCapabilities) !==
    JSON.stringify(original.declaredCapabilities)
  )
    patch.declaredCapabilities = values.declaredCapabilities;
  return patch;
}

function OverviewTab({
  detail,
  registry,
  disabled,
  onSaved,
  onError,
}: {
  detail: AdminVehicleDetail;
  registry: AdapterTypesResponse | null;
  disabled: boolean;
  onSaved: (msg: string) => Promise<void>;
  onError: (code: string) => void;
}) {
  const [values, setValues] = useState<VehicleFormValues>(() => detailToForm(detail));
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);

  // Re-sync form when the server copy changes (e.g. after save / refresh).
  useEffect(() => {
    setValues(detailToForm(detail));
    setErrors({});
  }, [detail]);

  const dirty = useMemo(
    () => Object.keys(buildPatch(detail, values)).length > 0,
    [detail, values],
  );

  function onChange(patch: Partial<VehicleFormValues>) {
    setValues((v) => ({ ...v, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key as keyof VehicleFormValues];
      return next;
    });
  }

  async function onSave() {
    const errs = { ...validateSection(values, "basic"), ...validateSection(values, "hardware") };
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    try {
      await adminUpdateVehicle(detail.vehicleId, buildPatch(detail, values));
      await onSaved("已儲存變更");
    } catch (err) {
      onError(err instanceof ApiError ? err.code : "save_failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6" data-testid="tab-overview">
      <div className="space-y-6">
        <VehicleFormFields
          section="basic"
          values={values}
          errors={errors}
          onChange={onChange}
          adapterTypes={registry?.adapterTypes ?? []}
          allCapabilities={registry?.allCapabilities ?? []}
          mode="edit"
        />
        <VehicleFormFields
          section="hardware"
          values={values}
          errors={errors}
          onChange={onChange}
          adapterTypes={registry?.adapterTypes ?? []}
          allCapabilities={registry?.allCapabilities ?? []}
          mode="edit"
        />
      </div>
      {dirty && !disabled && (
        <div className="mt-6 flex gap-3 justify-end">
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              setValues(detailToForm(detail));
              setErrors({});
            }}
            disabled={saving}
            data-testid="overview-cancel"
          >
            取消
          </Button>
          <Button size="md" onClick={onSave} disabled={saving} data-testid="overview-save">
            {saving ? "儲存中…" : "儲存"}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 部署 — deploy package + token mint
// ---------------------------------------------------------------------------

function DeployTab({
  busy,
  archived,
  mintedToken,
  onDownload,
  onMint,
}: {
  busy: boolean;
  archived: boolean;
  mintedToken: MintedVehicleToken | null;
  onDownload: () => void;
  onMint: (ttlSeconds: number, label: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-4" data-testid="tab-deploy">
      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold">部署套件</h2>
        <p className="mt-1 text-sm text-neutral-400">
          tar.gz 內含 r2-bridge.env（已填好 LiveKit 連線 + 新簽 7 天 token）、camera env 與該車 README 安裝 SOP。
        </p>
        <Button
          size="md"
          className="mt-4"
          onClick={onDownload}
          disabled={busy || archived}
          data-testid="deploy-download-btn"
        >
          下載部署套件
        </Button>
      </Card>

      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold">Edge Token</h2>
        <p className="mt-1 text-sm text-neutral-400">
          單獨重簽 token（不重下載整包）。舊 token 到期前自然失效，不會被撤銷。
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            variant="secondary"
            size="md"
            onClick={() => onMint(24 * 3600, "24h")}
            disabled={busy || archived}
            data-testid="mint-24h-btn"
          >
            重簽 24h token
          </Button>
          <Button
            variant="secondary"
            size="md"
            onClick={() => onMint(7 * 24 * 3600, "7d")}
            disabled={busy || archived}
            data-testid="mint-7d-btn"
          >
            重簽 7d token
          </Button>
        </div>

        {mintedToken ? (
          <div
            className="mt-5 rounded-xl border border-[var(--border-subtle)] bg-black/30 p-4"
            data-testid="minted-token"
          >
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-neutral-400">
              <span>room <code className="text-neutral-200">{mintedToken.roomName}</code></span>
              <span>identity <code className="text-neutral-200">{mintedToken.identity}</code></span>
              <span>
                到期{" "}
                <code className="text-neutral-200">
                  {new Date(mintedToken.expiresAt).toLocaleString("zh-TW", { hour12: false })}
                </code>
              </span>
            </div>
            <p className="mt-3 font-mono text-xs text-neutral-300 break-all line-clamp-3">
              {mintedToken.token}
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={async () => {
                await navigator.clipboard.writeText(mintedToken.token).catch(() => undefined);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              data-testid="copy-token-btn"
            >
              {copied ? "✅ 已複製" : "複製 token"}
            </Button>
          </div>
        ) : (
          <p className="mt-4 text-xs text-neutral-600">
            尚未在本頁重簽 token — token 只在簽發當下顯示一次，不會存在資料庫。
          </p>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 使用歷史 — recent leases + sessions
// ---------------------------------------------------------------------------

function HistoryTab({ detail }: { detail: AdminVehicleDetail }) {
  return (
    <div className="space-y-4" data-testid="tab-history">
      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold mb-3">最近 Lease（{detail.recentLeases.length}）</h2>
        {detail.recentLeases.length === 0 ? (
          <p className="text-sm text-neutral-500">尚無控制 lease 紀錄</p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {detail.recentLeases.map((l) => (
              <li key={l.id} className="py-2.5 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-neutral-200 truncate">{l.operatorEmail}</span>
                <span className="px-1.5 py-0.5 rounded border border-[var(--border-strong)] text-[11px] font-mono text-neutral-400">
                  {l.status}
                </span>
                <span className="text-xs text-neutral-500 font-mono ml-auto">
                  {new Date(l.createdAt).toLocaleString("zh-TW", { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold mb-3">最近 Session（{detail.recentSessions.length}）</h2>
        {detail.recentSessions.length === 0 ? (
          <p className="text-sm text-neutral-500">尚無 session 紀錄</p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {detail.recentSessions.map((s) => (
              <li key={s.sessionId} className="py-2.5 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-neutral-200 truncate">{s.userEmail}</span>
                <span className="px-1.5 py-0.5 rounded border border-[var(--border-strong)] text-[11px] font-mono text-neutral-400">
                  {s.purpose}
                </span>
                <span className="px-1.5 py-0.5 rounded border border-[var(--border-strong)] text-[11px] font-mono text-neutral-400">
                  {s.status}
                </span>
                <span className="text-xs text-neutral-500 font-mono ml-auto">
                  {new Date(s.createdAt).toLocaleString("zh-TW", { hour12: false })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 能力 — declared vs observed（observed-only → 橘色 warn per c15-p1 §6）
// ---------------------------------------------------------------------------

function CapabilitiesTab({ detail }: { detail: AdminVehicleDetail }) {
  const all = [...new Set([...detail.declaredCapabilities, ...detail.observedCapabilities])].sort();
  const hasUndeclared = detail.observedCapabilities.some(
    (c) => !detail.declaredCapabilities.includes(c),
  );

  return (
    <Card className="p-5 sm:p-6" data-testid="tab-capabilities">
      <h2 className="text-base font-semibold">Declared vs Observed</h2>
      <p className="mt-1 text-sm text-neutral-400">
        Declared = admin 設定；Observed = 車端自我回報。
      </p>
      {hasUndeclared && (
        <p className="mt-3 text-sm text-amber-400" data-testid="capabilities-warn">
          ⚠ 車端回報了未宣告的能力 — reality wins，請確認是否更新 declared 設定
        </p>
      )}

      {all.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">尚無 capability 資料</p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--border-subtle)]">
          {all.map((cap) => {
            const declared = detail.declaredCapabilities.includes(cap);
            const observed = detail.observedCapabilities.includes(cap);
            const undeclared = observed && !declared;
            return (
              <li
                key={cap}
                className="py-2.5 flex items-center gap-3 text-sm"
                data-testid={`cap-${cap}`}
              >
                {undeclared && (
                  <span className="text-amber-400" title="observed but not declared">
                    ⚠
                  </span>
                )}
                <code className={undeclared ? "text-amber-300" : "text-neutral-200"}>{cap}</code>
                <span className="ml-auto flex gap-2 text-[11px] font-mono">
                  <span
                    className={`px-1.5 py-0.5 rounded border ${
                      declared
                        ? "border-[var(--accent-blue)]/50 text-[var(--accent-blue)]"
                        : "border-[var(--border-subtle)] text-neutral-600"
                    }`}
                  >
                    declared
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded border ${
                      observed
                        ? undeclared
                          ? "border-amber-400/60 text-amber-300"
                          : "border-emerald-400/50 text-emerald-300"
                        : "border-[var(--border-subtle)] text-neutral-600"
                    }`}
                  >
                    observed
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Modal primitive
// ---------------------------------------------------------------------------

function Modal({
  children,
  onClose,
  testid,
}: {
  children: React.ReactNode;
  onClose: () => void;
  testid: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button
        aria-label="關閉"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <Card className="relative w-full max-w-sm p-6" data-testid={testid}>
        {children}
      </Card>
    </div>
  );
}
