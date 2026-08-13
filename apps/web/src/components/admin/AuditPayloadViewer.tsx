"use client";

import { ReactNode, useMemo } from "react";

/**
 * c15 P6 — minimal JSON payload viewer (no third-party dep, per project
 * red line): pretty-printed <pre> with regex-tokenized syntax colors.
 */

const TOKEN_RE =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlight(json: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of json.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      out.push(
        <span key={key++} className="text-neutral-600">
          {json.slice(last, idx)}
        </span>,
      );
    }
    const [full, str, colon] = m;
    if (str !== undefined) {
      // Object key (string followed by colon) vs string value.
      out.push(
        <span key={key++} className={colon ? "text-sky-300" : "text-emerald-300"}>
          {str}
        </span>,
      );
      if (colon) {
        out.push(
          <span key={key++} className="text-neutral-600">
            {colon}
          </span>,
        );
      }
    } else if (/^(true|false|null)$/.test(full)) {
      out.push(
        <span key={key++} className="text-purple-300">
          {full}
        </span>,
      );
    } else {
      out.push(
        <span key={key++} className="text-amber-300">
          {full}
        </span>,
      );
    }
    last = idx + full.length;
  }
  if (last < json.length) {
    out.push(
      <span key={key++} className="text-neutral-600">
        {json.slice(last)}
      </span>,
    );
  }
  return out;
}

export function AuditPayloadViewer({
  payload,
}: {
  payload: Record<string, unknown> | null;
}) {
  const nodes = useMemo(
    () => (payload ? highlight(JSON.stringify(payload, null, 2)) : null),
    [payload],
  );

  if (!nodes) {
    return <p className="text-xs text-neutral-600 font-mono">（無 payload）</p>;
  }
  return (
    <pre
      className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-all rounded-lg bg-black/40 border border-[var(--border-subtle)] p-3 max-h-80 overflow-y-auto"
      data-testid="audit-payload-viewer"
    >
      {nodes}
    </pre>
  );
}
