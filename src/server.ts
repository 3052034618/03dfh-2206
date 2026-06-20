import app from './app';
import { config } from './config';
import logger from './utils/logger';
import prisma from './config/prisma';
import { AlertRetryService } from './services/alertRetry.service';

const PORT = config.port;

let retryService: AlertRetryService | null = null;

async function startServer() {
  try {
    await prisma.$connect();
    logger.info('数据库连接成功');

    const server = app.listen(PORT, () => {
      logger.info(`冷链告警服务启动成功`);
      logger.info(`服务地址: http://localhost:${PORT}`);
      logger.info(`API文档根路径: http://localhost:${PORT}/`);
      logger.info(`环境: ${config.env}`);
    });

    retryService = new AlertRetryService();
    retryService.start();
    logger.info('告警重试服务已启动');

    const gracefulShutdown = async (signal: string) => {
      logger.info(`收到 ${signal} 信号，开始优雅关闭...`);

      if (retryService) {
        retryService.stop();
        logger.info('告警重试服务已停止');
      }

      server.close(async () => {
        logger.info('HTTP 服务器已关闭');
        await prisma.$disconnect();
        logger.info('数据库连接已断开');
        process.exit(0);
      });

      setTimeout(() => {
        logger.error('强制关闭超时，进程退出');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('uncaughtException', (error) => {
      logger.error('未捕获的异常:', error);
    });

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('未处理的 Promise 拒绝:', { reason, promise: String(promise) });
    });

  } catch (error) {
    logger.error('服务器启动失败:', error);
    process.exit(1);
  }
}

startServer();
