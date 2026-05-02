// lib/kenoService.ts
/**
 * Keno Sync Service - TypeScript port of vietlott_keno_to_pg.py
 * Handles: scraping vietlott.vn, calculating draw times, upserting to PostgreSQL
 */

import { Pool } from "pg";
import * as cheerio from "cheerio";
import { KenoRecord, LogEntry, SyncOptions, SyncResult } from "@/types/keno";
import { Element } from "domhandler";

// ── Constants ────────────────────────────────────────────────────────────────
const BASE_URL = "https://vietlott.vn";
const DETAIL_URL = (ky: number) =>
  `${BASE_URL}/vi/trung-thuong/ket-qua-trung-thuong/view-detail-keno-result?id=${String(ky).padStart(7, "0")}`;
const LATEST_URL = "https://ketquaday.vn/ket-qua-keno";

const KY_DAU_TIEN = 279434;
const PHUT_CACH = 8;
const GIO_DAU = "06:08";

const THU_FROM_WEEKDAY: Record<number, string> = {
  0: "CN", // Sunday
  1: "T2", // Monday
  2: "T3",
  3: "T4",
  4: "T5",
  5: "T6", // Friday → 2026-05-01 ✓
  6: "T7",
};

// Bac trung: so luong so chon -> cac muc trung thuong
const BAC_TRUNG: Record<number, number[]> = {
  10: [10, 9, 8, 7, 6, 5, 0],
  9: [9, 8, 7, 6, 5, 4, 0],
  8: [8, 7, 6, 5, 4, 0],
  7: [7, 6, 5, 4, 3],
  6: [6, 5, 4, 3],
  5: [5, 4, 3],
  4: [4, 3, 2],
  3: [3, 2],
  2: [2],
  1: [1],
};

const TAB_KEYS = [
  "chon_10",
  "chon_9",
  "chon_8",
  "chon_7",
  "chon_6",
  "chon_5",
  "chon_4",
  "chon_3",
  "chon_2",
  "chon_1",
];

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  Referer: `${BASE_URL}/vi/trung-thuong/ket-qua-trung-thuong/winning-number-keno`,
};

// ── DB Pool (singleton) ───────────────────────────────────────────────────────
let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      database: process.env.DB_NAME || "katalott",
      user: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "bin",
    });
  }
  return pool;
}

// ── Time calculation ─────────────────────────────────────────────────────────
// Dùng string "YYYY-MM-DD" thay vì Date object để tránh lệch timezone UTC vs local
function calcGio(
  ngay: string,
  ngayTruoc: string | null,
  gioTruoc: string | null,
): string {
  if (!ngayTruoc || !gioTruoc || ngay !== ngayTruoc) {
    return GIO_DAU; // sang ngày mới hoặc chưa có context → reset 06:08
  }
  // Cùng ngày → cộng thêm 8 phút
  const [h, m] = gioTruoc.split(":").map(Number);
  const total = h * 60 + m + PHUT_CACH;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// ── Parse prize tab ───────────────────────────────────────────────────────────
function parseTab(
  $: cheerio.CheerioAPI,
  pane: Element,
): Record<number, number> {
  const result: Record<number, number> = {};
  const table = $(pane).find("table.tabSelNumberInfo, table").first();
  if (!table.length) return result;

  table.find("tr").each((_, row) => {
    const cols = $(row).find("td");
    if (cols.length < 2) return;
    const text0 = $(cols[0]).text().trim();
    const m = text0.match(/Tr[uùú]ng\s+(\d+)/);
    if (!m) return;
    const soTrung = parseInt(m[1]);
    const val = $(cols[1]).text().trim();
    const sl = val.match(/S[oố]\s+l[uư][oợ]ng[:\s]*(\d+)/);
    result[soTrung] = sl ? parseInt(sl[1]) : 0;
  });
  return result;
}

function toBacString(bac: number, trungDict: Record<number, number>): string {
  return BAC_TRUNG[bac]
    .map(
      (muc) =>
        `${String(muc).padStart(2, "0")}-${String(trungDict[muc] ?? 0).padStart(2, "0")}`,
    )
    .join(",");
}

// ── Fetch & parse 1 draw ──────────────────────────────────────────────────────
// ngayTruoc dùng string "YYYY-MM-DD" để tránh timezone issue
export async function fetchKy(
  kySo: number,
  ngayTruoc: string | null = null,
  gioTruoc: string | null = null,
): Promise<KenoRecord | null> {
  const url = DETAIL_URL(kySo);
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;

    const html = await res.text();
    const kyStr7 = String(kySo).padStart(7, "0");
    if (!html.includes(`#${kyStr7}`) && !html.includes(String(kySo)))
      return null;

    const $ = cheerio.load(html);

    // 20 result numbers
    const soList: number[] = [];
    $("span.bong_tron.small").each((_, el) => {
      const t = $(el).text().trim();
      if (/^\d+$/.test(t)) soList.push(parseInt(t));
    });
    if (soList.length !== 20) return null;

    const n20 = [...soList]
      .sort((a, b) => a - b)
      .map((n) => String(n).padStart(2, "0"))
      .join(" ");

    // Parse date → string "YYYY-MM-DD" (tránh timezone UTC vs local)
    let ngay: string | null = null;
    const datePatterns = html.match(/(\d{2}\/\d{2}\/\d{4})/g);
    if (datePatterns?.length) {
      // Lấy date pattern cuối cùng — HTML vietlott.vn thường có nhiều date,
      // date của kỳ nằm ở cuối
      const last = datePatterns[datePatterns.length - 1];
      const parts = last.split("/"); // ["dd","mm","yyyy"]
      ngay = `${parts[2]}-${parts[1]}-${parts[0]}`; // "YYYY-MM-DD"
    }
    if (!ngay) return null;

    // Tính thứ từ string date, dùng local time
    const [yy, mm, dd] = ngay.split("-").map(Number);
    const thu = THU_FROM_WEEKDAY[new Date(yy, mm - 1, dd).getDay()];
    const gio = calcGio(ngay, ngayTruoc, gioTruoc);

    // Parse prize tabs
    const tabPanes = $("div.tab-content div.tab-pane").toArray();
    const parsedTabs: Record<string, Record<number, number>> = {};
    tabPanes.slice(0, 10).forEach((pane, i) => {
      parsedTabs[TAB_KEYS[i]] = parseTab($, pane);
    });

    const b: Record<number, string> = {};
    for (let bac = 10; bac >= 1; bac--) {
      b[bac] = toBacString(bac, parsedTabs[`chon_${bac}`] ?? {});
    }

    return {
      thu,
      ngay,
      gio,
      ky: kyStr7,
      n20,
      b10: b[10],
      b09: b[9],
      b08: b[8],
      b07: b[7],
      b06: b[6],
      b05: b[5],
      b04: b[4],
      b03: b[3],
      b02: b[2],
      b01: b[1],
    };
  } catch {
    return null;
  }
}

// ── Get latest draw from site ─────────────────────────────────────────────────
export async function getLatestKySite(): Promise<number | null> {
  try {
    const res = await fetch(LATEST_URL, {
      headers: HEADERS,
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    const matches = [...html.matchAll(/ket-qua-keno-ky-(\d+)/g)];
    if (matches.length) return Math.max(...matches.map((m) => parseInt(m[1])));
  } catch {
    /* silent */
  }
  return null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
export async function getLatestInDb(
  pool: Pool,
): Promise<{ ky: number | null; ngay: string | null; gio: string | null }> {
  // Cast ngay::text để tránh pg driver tự convert sang Date object (gây lệch timezone)
  const res = await pool.query<{ ky: string; ngay: string; gio: string }>(`
    SELECT ky, ngay::text, gio FROM public.kenokq
    ORDER BY CAST(ky AS INTEGER) DESC LIMIT 1
  `);
  if (res.rows[0]) {
    return {
      ky: parseInt(res.rows[0].ky),
      ngay: res.rows[0].ngay, // đã là "YYYY-MM-DD" string
      gio: res.rows[0].gio,
    };
  }
  return { ky: null, ngay: null, gio: null };
}

const UPSERT_SQL = `
INSERT INTO public.kenokq (
  thu, ngay, gio, ky, n20,
  b10, b09, b08, b07, b06,
  b05, b04, b03, b02, b01
) VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
)
ON CONFLICT (ky) DO UPDATE SET
  thu=EXCLUDED.thu, ngay=EXCLUDED.ngay, gio=EXCLUDED.gio,
  n20=EXCLUDED.n20,
  b10=EXCLUDED.b10, b09=EXCLUDED.b09, b08=EXCLUDED.b08,
  b07=EXCLUDED.b07, b06=EXCLUDED.b06, b05=EXCLUDED.b05,
  b04=EXCLUDED.b04, b03=EXCLUDED.b03, b02=EXCLUDED.b02,
  b01=EXCLUDED.b01
`;

export async function upsertRecord(
  pool: Pool,
  data: KenoRecord,
): Promise<void> {
  await pool.query(UPSERT_SQL, [
    data.thu,
    data.ngay,
    data.gio,
    data.ky,
    data.n20,
    data.b10,
    data.b09,
    data.b08,
    data.b07,
    data.b06,
    data.b05,
    data.b04,
    data.b03,
    data.b02,
    data.b01,
  ]);
}

// ── Main sync logic ───────────────────────────────────────────────────────────
export async function syncMissing(
  options: SyncOptions,
  onProgress?: (
    log: LogEntry,
    progress: { current: number; total: number },
  ) => void,
): Promise<SyncResult> {
  const logs: LogEntry[] = [];
  let ok = 0,
    skip = 0,
    err = 0;

  const latestSite = await getLatestKySite();
  if (!latestSite) {
    return {
      ok: 0,
      skip: 0,
      err: 1,
      kyFrom: 0,
      kyTo: 0,
      logs: [
        {
          ky: 0,
          status: "error",
          message: "Không lấy được kỳ mới nhất từ site",
        },
      ],
    };
  }

  const db = getPool();
  // const {
  //   ky: latestDbKy,
  //   ngay: latestDbNgay,
  //   gio: latestDbGio,
  // } = await getLatestInDb(db);

  const latestDbKy = 279623;
  const latestDbNgay = "2026-05-02";
  const latestDbGio = "15:28";

  let kyFrom: number;
  let ngayTruoc: string | null = null;
  let gioTruoc: string | null = null;

  if (latestDbKy) {
    kyFrom = latestDbKy + 1;
    ngayTruoc = latestDbNgay;
    gioTruoc = latestDbGio;
  } else {
    kyFrom = options.startKy ?? KY_DAU_TIEN;
  }

  const kyTo = latestSite;
  if (kyFrom > kyTo) {
    return {
      ok: 0,
      skip: 0,
      err: 0,
      kyFrom,
      kyTo,
      logs: [{ ky: 0, status: "skip", message: "DB đã cập nhật đầy đủ" }],
    };
  }

  const kyList = Array.from(
    { length: kyTo - kyFrom + 1 },
    (_, i) => kyFrom + i,
  );
  const total = kyList.length;

  for (let i = 0; i < kyList.length; i++) {
    const kySo = kyList[i];
    const data = await fetchKy(kySo, ngayTruoc, gioTruoc);

    if (!data) {
      skip++;
      const log: LogEntry = {
        ky: kySo,
        status: "skip",
        message: `Bỏ qua kỳ ${kySo}`,
      };
      logs.push(log);
      onProgress?.(log, { current: i + 1, total });
      continue;
    }

    if (!options.dryRun) {
      try {
        await upsertRecord(db, data);
        ok++;
        const log: LogEntry = {
          ky: kySo,
          status: "ok",
          message: "Upsert thành công",
          data,
        };
        logs.push(log);
        onProgress?.(log, { current: i + 1, total });
      } catch (e) {
        err++;
        const log: LogEntry = { ky: kySo, status: "error", message: String(e) };
        logs.push(log);
        onProgress?.(log, { current: i + 1, total });
      }
    } else {
      ok++;
      const log: LogEntry = {
        ky: kySo,
        status: "dry-run",
        message: "[DRY-RUN] Không insert",
        data,
      };
      logs.push(log);
      onProgress?.(log, { current: i + 1, total });
    }

    ngayTruoc = data.ngay;
    gioTruoc = data.gio;

    if (i < kyList.length - 1) {
      await new Promise((r) => setTimeout(r, options.delay * 1000));
    }
  }

  return { ok, skip, err, kyFrom, kyTo, logs };
}
