export type CheckStatus = "ok" | "warn" | "error" | "skip";

export interface CheckResult {
  category: string;
  name: string;
  status: CheckStatus;
  message: string;
  fix_hint?: string;
  details?: Record<string, unknown>;
  auto_fixable?: boolean;
}

export interface DoctorReport {
  timestamp: string;
  total: number;
  passed: number;
  warnings: number;
  errors: number;
  results: CheckResult[];
}

export interface DoctorCheck {
  id: string;
  name: string;
  category: string;
  run(context: DoctorContext): Promise<CheckResult>;
}

export interface DoctorContext {
  baseDir: string;
  profile: string;
  configManager: any;
}
