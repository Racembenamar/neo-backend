export const DEFAULT_WORKER_PERMISSIONS = {
  canAccessNewSession: true,
  canScanPlayer: true,
  canSearchPlayer: true,
  canAddGamesToSession: true,
  canEditSessionAmount: true,
  canConfirmBilling: true,
  canCreateAnnouncement: false,
  canViewTournaments: false,
  canCreateTournament: false,
  canEditTournament: false,
  canDeleteTournament: false,
  canEnableDisableTournament: false,
  canScheduleTournament: false,
  canManageParticipants: false,
  canStartTournament: false,
  canManageMatches: false,
  canManageScorecard: false,
  canViewReports: false,
  canViewFinancialStats: false,
  canManageGames: false,
  canEditPrices: false,
  canManageWorkers: false,
  canManageStoreSettings: false,
} as const;

export type WorkerPermission = keyof typeof DEFAULT_WORKER_PERMISSIONS;
export type WorkerPermissions = Record<WorkerPermission, boolean>;

export const WORKER_PERMISSION_KEYS = Object.keys(DEFAULT_WORKER_PERMISSIONS) as WorkerPermission[];

export function normalizeWorkerPermissions(input: unknown): WorkerPermissions {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  return WORKER_PERMISSION_KEYS.reduce((acc, key) => {
    acc[key] = typeof raw[key] === 'boolean' ? raw[key] as boolean : DEFAULT_WORKER_PERMISSIONS[key];
    return acc;
  }, {} as WorkerPermissions);
}

export function pickWorkerPermissions(input: unknown): WorkerPermissions {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const permissions: WorkerPermissions = { ...DEFAULT_WORKER_PERMISSIONS };
  WORKER_PERMISSION_KEYS.forEach((key) => {
    permissions[key] = Boolean(raw[key]);
  });
  return permissions;
}
