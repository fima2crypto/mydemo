"use client";
// app/keno/sync/page.tsx

import { useState, useRef, useCallback } from "react";
import { LogEntry, SyncResult } from "@/types/keno";

// ── Types for stream events ───────────────────────────────────────────────────
type StreamEvent =
  | { type: "start"; kyFrom: number; kyTo: number; total: number }
  | { type: "progress"; log: LogEntry; current: number; total: number }
  | { type: "done"; result: SyncResult }
  | { type: "error"; message: string };

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: LogEntry["status"] }) {
  const cfg = {
    ok: {
      label: "OK",
      cls: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
    },
    skip: {
      label: "SKIP",
      cls: "bg-yellow-500/20  text-yellow-300  border-yellow-500/30",
    },
    error: {
      label: "ERR",
      cls: "bg-red-500/20     text-red-300     border-red-500/30",
    },
    "dry-run": {
      label: "DRY",
      cls: "bg-blue-500/20   text-blue-300    border-blue-500/30",
    },
  }[status];
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[10px] font-mono font-bold border ${cfg.cls}`}
    >
      {cfg.label}
    </span>
  );
}

// ── Log row ───────────────────────────────────────────────────────────────────
function LogRow({ log }: { log: LogEntry }) {
  return (
    <div className="flex items-start gap-3 py-2 px-3 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] transition-colors">
      <span className="font-mono text-[11px] text-slate-500 w-16 shrink-0 pt-0.5">
        #{log.ky}
      </span>
      <div className="flex-1 min-w-0">
        {log.data && (
          <p className="font-mono text-[11px] text-slate-300 truncate">
            <span className="text-amber-400">{log.data.ngay}</span>
            <span className="text-slate-500 mx-1">·</span>
            <span className="text-sky-400">{log.data.gio}</span>
            <span className="text-slate-500 mx-1">·</span>
            <span className="text-slate-400">{log.data.thu}</span>
            <span className="text-slate-500 mx-1">·</span>
            <span className="text-slate-300">{log.data.n20}</span>
          </p>
        )}
        {!log.data && (
          <p className="font-mono text-[11px] text-slate-500 truncate">
            {log.message}
          </p>
        )}
      </div>
      <StatusBadge status={log.status} />
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function KenoSyncPage() {
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Options
  const [dryRun, setDryRun] = useState(false);
  const [delay, setDelay] = useState(1.0);
  const [startKy, setStartKy] = useState("");

  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollToBottom = () =>
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });

  const handleSync = useCallback(async () => {
    setRunning(true);
    setLogs([]);
    setResult(null);
    setError(null);
    setProgress(null);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/keno/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dryRun,
          delay,
          startKy: startKy ? parseInt(startKy) : undefined,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.body) throw new Error("No response stream");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event: StreamEvent = JSON.parse(line);
            if (event.type === "progress") {
              setLogs((prev) => [...prev, event.log]);
              setProgress({ current: event.current, total: event.total });
              setTimeout(scrollToBottom, 50);
            } else if (event.type === "done") {
              setResult(event.result);
            } else if (event.type === "error") {
              setError(event.message);
            }
          } catch {
            /* skip malformed lines */
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== "AbortError") {
        setError(String(e));
      }
    } finally {
      setRunning(false);
    }
  }, [dryRun, delay, startKy]);

  const handleStop = () => {
    abortRef.current?.abort();
    setRunning(false);
  };

  const pct = progress
    ? Math.round((progress.current / progress.total) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-[#0a0d12] text-slate-100 font-sans p-6 md:p-10">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">
            🎱 Keno Sync
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Đồng bộ kết quả Vietlott Keno từ site → PostgreSQL
          </p>
        </div>

        {/* Options card */}
        <div className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-5 space-y-4">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-widest">
            Tuỳ chọn
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {/* Dry Run */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <div
                onClick={() => !running && setDryRun((v) => !v)}
                className={`w-10 h-5 rounded-full transition-colors relative ${
                  dryRun ? "bg-blue-500" : "bg-white/10"
                }`}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    dryRun ? "translate-x-5" : "translate-x-0.5"
                  }`}
                />
              </div>
              <span className="text-sm text-slate-300">Dry Run</span>
            </label>

            {/* Delay */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">Delay (giây)</label>
              <input
                type="number"
                min={0.5}
                max={10}
                step={0.5}
                value={delay}
                disabled={running}
                onChange={(e) => setDelay(parseFloat(e.target.value) || 1)}
                className="bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-sky-500/60 disabled:opacity-50"
              />
            </div>

            {/* Start Ky */}
            <div className="flex flex-col gap-1">
              <label className="text-xs text-slate-500">
                Start Kỳ (nếu DB trống)
              </label>
              <input
                type="number"
                //placeholder="279077"
                placeholder="0279434"
                value={startKy}
                disabled={running}
                onChange={(e) => setStartKy(e.target.value)}
                className="bg-white/[0.06] border border-white/[0.1] rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-sky-500/60 disabled:opacity-50"
              />
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex gap-3 pt-1">
            <button
              onClick={handleSync}
              disabled={running}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-semibold text-white transition-colors"
            >
              {running ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Đang sync…
                </>
              ) : (
                <>▶ Bắt đầu Sync</>
              )}
            </button>

            {running && (
              <button
                onClick={handleStop}
                className="px-5 py-2.5 rounded-lg bg-red-600/80 hover:bg-red-500 text-sm font-semibold text-white transition-colors"
              >
                ■ Dừng
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {(running || result) && progress && (
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs text-slate-500">
              <span>
                {progress.current} / {progress.total} kỳ
              </span>
              <span>{pct}%</span>
            </div>
            <div className="h-1.5 bg-white/[0.08] rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full transition-all duration-300"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {/* Result summary */}
        {result && (
          <div className="grid grid-cols-3 gap-3">
            {[
              {
                label: "Thành công",
                value: result.ok,
                color: "text-emerald-400",
              },
              { label: "Bỏ qua", value: result.skip, color: "text-yellow-400" },
              { label: "Lỗi", value: result.err, color: "text-red-400" },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-xl border border-white/[0.08] bg-white/[0.04] p-4 text-center"
              >
                <div className={`text-3xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-xs text-slate-500 mt-1">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
            ⚠ {error}
          </div>
        )}

        {/* Log panel */}
        {logs.length > 0 && (
          <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-widest">
                Log ({logs.length})
              </span>
              {dryRun && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                  DRY RUN
                </span>
              )}
            </div>
            <div className="max-h-[400px] overflow-y-auto p-2 space-y-0.5">
              {logs.map((log, i) => (
                <LogRow key={i} log={log} />
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
