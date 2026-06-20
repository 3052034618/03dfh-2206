import { notificationService } from './notification.service';
import logger from '../utils/logger';
import { config } from '../config';

export class AlertRetryService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  constructor(
    private intervalSeconds: number = config.alert.retryIntervalSeconds
  ) {}

  start(): void {
    if (this.isRunning) {
      logger.warn('告警重试服务已在运行中');
      return;
    }

    this.isRunning = true;
    this.intervalId = setInterval(async () => {
      await this.runRetry();
    }, this.intervalSeconds * 1000);

    logger.info(`告警重试服务已启动，间隔 ${this.intervalSeconds}s`);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    logger.info('告警重试服务已停止');
  }

  private async runRetry(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const result = await notificationService.retryFailedNotifications();
      if (result.retried > 0) {
        logger.info(`通知重试完成: 重试${result.retried}条, 成功${result.succeeded}条, 失败${result.failed}条`);
      }
    } catch (error: any) {
      logger.error('通知重试任务异常:', error);
    }
  }
}
