// app/api/keno/sync/route.ts
/**
 * POST /api/keno/sync
 * Body: { dryRun?: boolean, delay?: number, startKy?: number }
 *
 * Streams NDJSON (newline-delimited JSON) so the UI can show live progress.
 * Each line is one of:
 *   { type: "start",    kyFrom, kyTo, total }
 *   { type: "progress", log: LogEntry, current, total }
 *   { type: "done",     result: SyncResult }
 *   { type: "error",    message: string }
 */

import { NextRequest } from "next/server";
import { syncMissing } from "@/lib/kenoService";
import { LogEntry, SyncOptions } from "@/types/keno";

export const runtime = "nodejs"; // needs Node APIs (pg, fetch)
export const maxDuration = 300;  // 5 min timeout for long syncs

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  const options: SyncOptions = {
    dryRun:  body.dryRun  ?? false,
    delay:   body.delay   ?? 1.0,
    startKy: body.startKy ?? undefined,
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: object) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };

      try {
        let resolvedTotal = 0;

        const result = await syncMissing(
          options,
          (log: LogEntry, progress) => {
            resolvedTotal = progress.total;
            send({ type: "progress", log, current: progress.current, total: progress.total });
          }
        );

        send({ type: "done", result });
      } catch (e) {
        send({ type: "error", message: String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
