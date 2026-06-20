import { Router, Request, Response } from 'express';
import { query, param } from 'express-validator';
import prisma from '../config/prisma';
import { validateRequest, parsePagination } from '../middleware/validate';
import { successResponse, paginatedResponse, errorResponse } from '../utils/response';
import { NotificationChannelArray, NotificationStatusArray, NotificationStatus } from '../types/enums';
import { notificationService } from '../services/notification.service';

const router = Router();

const validChannels = NotificationChannelArray;
const validStatuses = NotificationStatusArray;

router.get(
  '/',
  [
    query('alertRecordId').optional().isInt().toInt(),
    query('userId').optional().isInt().toInt(),
    query('role').optional().isString(),
    query('channel').optional().isIn(validChannels),
    query('status').optional().isIn(validStatuses),
    query('startTime').optional().isISO8601(),
    query('endTime').optional().isISO8601(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { alertRecordId, userId, role, channel, status, startTime, endTime } = req.query;

      const where: any = {};
      if (alertRecordId) where.alertRecordId = parseInt(alertRecordId as string);
      if (userId) where.userId = parseInt(userId as string);
      if (role) where.role = role;
      if (channel) where.channel = channel;
      if (status) where.status = status;
      if (startTime || endTime) {
        where.createdAt = {};
        if (startTime) where.createdAt.gte = new Date(startTime as string);
        if (endTime) where.createdAt.lte = new Date(endTime as string);
      }

      const [total, data] = await Promise.all([
        prisma.alertNotification.count({ where }),
        prisma.alertNotification.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
          include: {
            user: { select: { id: true, username: true, realName: true, role: true, phone: true } },
            alertRecord: {
              select: {
                id: true, alertLevel: true, status: true,
                shipment: { select: { shipmentNo: true, vehicle: { select: { plateNumber: true } } } }
              }
            }
          }
        })
      ]);

      paginatedResponse(res, data, page, pageSize, total);
    } catch (error: any) {
      errorResponse(res, error.message, 500);
    }
  }
);

router.get('/stats/channel', [
  query('startTime').optional().isISO8601(),
  query('endTime').optional().isISO8601(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const { startTime, endTime } = req.query;
    const where: any = {};
    if (startTime || endTime) {
      where.createdAt = {};
      if (startTime) where.createdAt.gte = new Date(startTime as string);
      if (endTime) where.createdAt.lte = new Date(endTime as string);
    }

    const [byChannel, byStatus, total] = await Promise.all([
      prisma.alertNotification.groupBy({
        by: ['channel'],
        where,
        _count: { id: true }
      }),
      prisma.alertNotification.groupBy({
        by: ['status'],
        where,
        _count: { id: true }
      }),
      prisma.alertNotification.count({ where })
    ]);

    successResponse(res, {
      total,
      byChannel: Object.fromEntries(byChannel.map(x => [x.channel, x._count.id])),
      byStatus: Object.fromEntries(byStatus.map(x => [x.status, x._count.id])),
      successRate: total > 0 ? {
        sent: byStatus.find(s => s.status === NotificationStatus.SENT)?._count.id || 0,
        rate: ((byStatus.find(s => s.status === NotificationStatus.SENT)?._count.id || 0) / total * 100).toFixed(1) + '%'
      } : null
    });
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.get('/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const notification = await prisma.alertNotification.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        user: { select: { id: true, username: true, realName: true, role: true, phone: true, email: true } },
        alertRecord: {
          include: {
            shipment: { select: { shipmentNo: true, vehicle: { select: { plateNumber: true } } } },
            customer: { select: { name: true } },
            alertRule: { select: { name: true } }
          }
        }
      }
    });

    if (!notification) return errorResponse(res, '通知记录不存在', 404);
    successResponse(res, notification);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.post('/retry', async (_req: Request, res: Response) => {
  try {
    const result = await notificationService.retryFailedNotifications();
    successResponse(res, result, '重试任务完成');
  } catch (error: any) {
    errorResponse(res, `重试失败: ${error.message}`, 500);
  }
});

router.post('/:id/retry', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const n = await prisma.alertNotification.findUnique({
      where: { id },
      include: { user: true }
    });
    if (!n) return errorResponse(res, '通知记录不存在', 404);
    if (!n.user) return errorResponse(res, '关联用户不存在', 404);

    try {
      await (notificationService as any).sendViaChannel(n, n.channel, n.content, n.recipient, n.user);

      await prisma.alertNotification.update({
        where: { id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          retryCount: { increment: 1 },
          errorMessage: null
        }
      });
      successResponse(res, { id, retried: true }, '重新发送成功');
    } catch (e: any) {
      await prisma.alertNotification.update({
        where: { id },
        data: {
          retryCount: { increment: 1 },
          errorMessage: e.message?.substring(0, 500)
        }
      });
      errorResponse(res, `发送失败: ${e.message}`, 500);
    }
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.patch('/:id/ack', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const updated = await prisma.alertNotification.update({
      where: { id },
      data: {
        status: NotificationStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date()
      }
    });
    successResponse(res, updated, '已标记为已读');
  } catch (error: any) {
    errorResponse(res, error.message, 400);
  }
});

export default router;
