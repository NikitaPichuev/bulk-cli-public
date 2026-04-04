import fs from "fs";
import path from "path";

export interface ActivityRunRecord {
  startedAt: string;
  completedAt?: string;
  localDate: string;
  faucetStatus?: string;
  tradesPlanned: number;
  tradesCompleted: number;
  tradesFailed: number;
}

export interface AccountActivityState {
  accountAddress: string;
  lastActiveDate?: string;
  activeDaysStreak: number;
  lastFaucetAttemptDate?: string;
  lastRunAt?: string;
  totalRoutineRuns: number;
  totalTradesCompleted: number;
  recentRuns: ActivityRunRecord[];
}

export interface ActivityStateFile {
  version: 1;
  timezone: string;
  accounts: Record<string, AccountActivityState>;
}

const EMPTY_STATE: ActivityStateFile = {
  version: 1,
  timezone: "UTC",
  accounts: {}
};

export function resolveActivityStateFile(filePath: string): string {
  return path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
}

export function loadActivityState(filePath: string, timezone: string): ActivityStateFile {
  const resolved = resolveActivityStateFile(filePath);

  if (!fs.existsSync(resolved)) {
    return {
      ...EMPTY_STATE,
      timezone
    };
  }

  const raw = fs.readFileSync(resolved, "utf8").trim();

  if (!raw) {
    return {
      ...EMPTY_STATE,
      timezone
    };
  }

  const parsed = JSON.parse(raw) as Partial<ActivityStateFile>;
  const accounts = parsed.accounts && typeof parsed.accounts === "object"
    ? Object.fromEntries(
        Object.entries(parsed.accounts).map(([accountAddress, value]) => [accountAddress, normalizeAccountState(accountAddress, value)])
      )
    : {};

  return {
    version: 1,
    timezone: typeof parsed.timezone === "string" && parsed.timezone.trim() ? parsed.timezone : timezone,
    accounts
  };
}

export function saveActivityState(filePath: string, state: ActivityStateFile): void {
  const resolved = resolveActivityStateFile(filePath);
  fs.writeFileSync(resolved, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export function getOrCreateAccountActivity(state: ActivityStateFile, accountAddress: string): AccountActivityState {
  const existing = state.accounts[accountAddress];

  if (existing) {
    return existing;
  }

  const created: AccountActivityState = {
    accountAddress,
    activeDaysStreak: 0,
    totalRoutineRuns: 0,
    totalTradesCompleted: 0,
    recentRuns: []
  };

  state.accounts[accountAddress] = created;
  return created;
}

function normalizeAccountState(accountAddress: string, value: unknown): AccountActivityState {
  const input = value && typeof value === "object"
    ? value as Partial<AccountActivityState>
    : {};

  return {
    accountAddress,
    lastActiveDate: typeof input.lastActiveDate === "string" ? input.lastActiveDate : undefined,
    activeDaysStreak: Number.isFinite(input.activeDaysStreak) ? Number(input.activeDaysStreak) : 0,
    lastFaucetAttemptDate: typeof input.lastFaucetAttemptDate === "string" ? input.lastFaucetAttemptDate : undefined,
    lastRunAt: typeof input.lastRunAt === "string" ? input.lastRunAt : undefined,
    totalRoutineRuns: Number.isFinite(input.totalRoutineRuns) ? Number(input.totalRoutineRuns) : 0,
    totalTradesCompleted: Number.isFinite(input.totalTradesCompleted) ? Number(input.totalTradesCompleted) : 0,
    recentRuns: Array.isArray(input.recentRuns)
      ? input.recentRuns
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => normalizeRunRecord(entry as Partial<ActivityRunRecord>))
      : []
  };
}

function normalizeRunRecord(value: Partial<ActivityRunRecord>): ActivityRunRecord {
  return {
    startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString(),
    completedAt: typeof value.completedAt === "string" ? value.completedAt : undefined,
    localDate: typeof value.localDate === "string" ? value.localDate : "1970-01-01",
    faucetStatus: typeof value.faucetStatus === "string" ? value.faucetStatus : undefined,
    tradesPlanned: Number.isFinite(value.tradesPlanned) ? Number(value.tradesPlanned) : 0,
    tradesCompleted: Number.isFinite(value.tradesCompleted) ? Number(value.tradesCompleted) : 0,
    tradesFailed: Number.isFinite(value.tradesFailed) ? Number(value.tradesFailed) : 0
  };
}
