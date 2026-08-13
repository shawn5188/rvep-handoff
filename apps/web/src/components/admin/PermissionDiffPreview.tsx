"use client";

import type { RoleName } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { RoleBadge } from "@/components/admin/RoleBadge";

/**
 * c15 P5 — batch-save confirmation modal: shows the pending diff
 * (added / removed / changed) before the PUT full-replace goes out.
 */

interface PermState {
  role: RoleName;
  priorityOverride: number | null;
}

export interface DiffAddedItem {
  userEmail: string;
  vehicleLabel: string;
  to: PermState;
}

export interface DiffRemovedItem {
  userEmail: string;
  vehicleLabel: string;
  from: PermState;
}

export interface DiffChangedItem {
  userEmail: string;
  vehicleLabel: string;
  from: PermState;
  to: PermState;
}

export interface PermissionDiffData {
  added: DiffAddedItem[];
  removed: DiffRemovedItem[];
  changed: DiffChangedItem[];
}

function PermChip({ perm }: { perm: PermState }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <RoleBadge role={perm.role} />
      {perm.priorityOverride !== null && (
        <span className="px-1.5 py-0.5 rounded border border-amber-400/50 text-[11px] font-mono text-amber-300">
          +{perm.priorityOverride}
        </span>
      )}
    </span>
  );
}

function Row({
  userEmail,
  vehicleLabel,
  children,
}: {
  userEmail: string;
  vehicleLabel: string;
  children: React.ReactNode;
}) {
  return (
    <li className="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="text-neutral-300 truncate max-w-[45%]">{userEmail}</span>
      <span className="font-mono text-neutral-500">{vehicleLabel}</span>
      <span className="ml-auto flex items-center gap-2">{children}</span>
    </li>
  );
}

function Section({
  title,
  tone,
  count,
  children,
}: {
  title: string;
  tone: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div className="mt-4 first:mt-0">
      <h3 className={`text-xs font-mono uppercase tracking-wide ${tone}`}>
        {title}（{count}）
      </h3>
      <ul className="mt-1 divide-y divide-[var(--border-subtle)]">{children}</ul>
    </div>
  );
}

export function PermissionDiffPreview({
  diff,
  saving,
  onConfirm,
  onCancel,
}: {
  diff: PermissionDiffData;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const total = diff.added.length + diff.removed.length + diff.changed.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        aria-label="取消"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => !saving && onCancel()}
      />
      <Card
        className="relative w-full max-w-lg max-h-[85dvh] p-6 flex flex-col"
        data-testid="permission-diff-modal"
      >
        <h2 className="text-lg font-semibold">確認權限變更（{total} 筆）</h2>
        <p className="mt-1 text-sm text-neutral-400">
          按「確認儲存」後才會寫入，並記錄到 audit log。
        </p>

        <div className="mt-4 flex-1 overflow-y-auto pr-1">
          <Section title="新增" tone="text-emerald-300" count={diff.added.length}>
            {diff.added.map((d, i) => (
              <Row key={i} userEmail={d.userEmail} vehicleLabel={d.vehicleLabel}>
                <PermChip perm={d.to} />
              </Row>
            ))}
          </Section>

          <Section title="移除" tone="text-[var(--accent-red)]" count={diff.removed.length}>
            {diff.removed.map((d, i) => (
              <Row key={i} userEmail={d.userEmail} vehicleLabel={d.vehicleLabel}>
                <PermChip perm={d.from} />
                <span className="text-neutral-600 text-xs">→ 無權限</span>
              </Row>
            ))}
          </Section>

          <Section title="修改" tone="text-amber-300" count={diff.changed.length}>
            {diff.changed.map((d, i) => (
              <Row key={i} userEmail={d.userEmail} vehicleLabel={d.vehicleLabel}>
                <PermChip perm={d.from} />
                <span className="text-neutral-600">→</span>
                <PermChip perm={d.to} />
              </Row>
            ))}
          </Section>
        </div>

        <div className="mt-5 flex gap-3 justify-end">
          <Button variant="ghost" size="md" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button
            size="md"
            onClick={onConfirm}
            disabled={saving || total === 0}
            data-testid="diff-confirm-btn"
          >
            {saving ? "儲存中…" : "確認儲存"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
