export const UserRole = {
  DRIVER: 'DRIVER',
  DISPATCHER: 'DISPATCHER',
  QC_CUSTOMER: 'QC_CUSTOMER',
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR'
} as const;

export type UserRole = typeof UserRole[keyof typeof UserRole];
export const UserRoleArray = Object.values(UserRole) as UserRole[];

export const ProbeLocation = {
  CARGO_CORE: 'CARGO_CORE',
  DOOR: 'DOOR',
  RETURN_AIR: 'RETURN_AIR',
  EVAPORATOR: 'EVAPORATOR',
  AMBIENT: 'AMBIENT',
  CUSTOM: 'CUSTOM'
} as const;

export type ProbeLocation = typeof ProbeLocation[keyof typeof ProbeLocation];
export const ProbeLocationArray = Object.values(ProbeLocation) as ProbeLocation[];

export const TemperatureZone = {
  FROZEN: 'FROZEN',
  CHILLED: 'CHILLED',
  CONSTANT_TEMP: 'CONSTANT_TEMP',
  AMBIENT: 'AMBIENT',
  DUAL_TEMP: 'DUAL_TEMP'
} as const;

export type TemperatureZone = typeof TemperatureZone[keyof typeof TemperatureZone];
export const TemperatureZoneArray = Object.values(TemperatureZone) as TemperatureZone[];

export const AlertLevel = {
  ATTENTION: 'ATTENTION',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
  FATAL: 'FATAL'
} as const;

export type AlertLevel = typeof AlertLevel[keyof typeof AlertLevel];
export const AlertLevelArray = Object.values(AlertLevel) as AlertLevel[];

export const AlertStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
  FALSE_ALARM: 'FALSE_ALARM'
} as const;

export type AlertStatus = typeof AlertStatus[keyof typeof AlertStatus];
export const AlertStatusArray = Object.values(AlertStatus) as AlertStatus[];

export const NotificationChannel = {
  COLD_CHAIN_PLATFORM: 'COLD_CHAIN_PLATFORM',
  DRIVER_APP: 'DRIVER_APP',
  WECHAT_WORK: 'WECHAT_WORK',
  SMS: 'SMS',
  EMAIL: 'EMAIL'
} as const;

export type NotificationChannel = typeof NotificationChannel[keyof typeof NotificationChannel];
export const NotificationChannelArray = Object.values(NotificationChannel) as NotificationChannel[];

export const NotificationStatus = {
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  ACKNOWLEDGED: 'ACKNOWLEDGED'
} as const;

export type NotificationStatus = typeof NotificationStatus[keyof typeof NotificationStatus];
export const NotificationStatusArray = Object.values(NotificationStatus) as NotificationStatus[];
