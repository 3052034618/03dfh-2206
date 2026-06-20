import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  env: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',

  database: {
    url: process.env.DATABASE_URL || 'file:./dev.db'
  },

  wechatWork: {
    webhookUrl: process.env.WECHAT_WORK_WEBHOOK_URL || ''
  },

  coldChainPlatform: {
    callbackUrl: process.env.COLD_CHAIN_PLATFORM_CALLBACK || ''
  },

  driverApp: {
    pushUrl: process.env.DRIVER_APP_PUSH_URL || ''
  },

  alert: {
    debounceMinutes: 5,
    maxRetryCount: 3,
    retryIntervalSeconds: 60
  }
};

export type Config = typeof config;
