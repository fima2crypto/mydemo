// types/keno.ts

export interface SyncOptions {
  dryRun: boolean;
  delay: number;       // seconds between requests
  startKy?: number;   // only used when DB is empty
}

export interface SyncResult {
  ok: number;
  skip: number;
  err: number;
  kyFrom: number;
  kyTo: number;
  logs: LogEntry[];
}

export interface LogEntry {
  ky: number;
  status: "ok" | "skip" | "error" | "dry-run";
  message: string;
  data?: KenoRecord;
}

export interface KenoRecord {
  thu: string;
  ngay: string;   // ISO date string
  gio: string;
  ky: string;
  n20: string;
  b10: string;
  b09: string;
  b08: string;
  b07: string;
  b06: string;
  b05: string;
  b04: string;
  b03: string;
  b02: string;
  b01: string;
}

export interface SyncStatus {
  running: boolean;
  progress?: {
    current: number;
    total: number;
    kyFrom: number;
    kyTo: number;
  };
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}
