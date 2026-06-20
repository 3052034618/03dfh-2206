import { Router, Request, Response } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../config/prisma';
import { validateRequest, parsePagination } from '../middleware/validate';
import { successResponse, paginatedResponse, errorResponse } from '../utils/response';
import logger from '../utils/logger';
import { AlertLevelArray, AlertStatusArray, ProbeLocationArray, UserRoleArray, UserRole, NotificationStatus, AlertStatus } from '../types/enums';
import { notificationService } from '../services/notification.service';
import { alertEngine } from '../services/alertEngine.service';

const router = Router();

const validAlertLevels = AlertLevelArray;
const validStatuses = AlertStatusArray;
const validLocations = ProbeLocationArray;

router.get(
  '/',
  [
    query('shipmentId').optional().isInt().toInt(),
    query('shipmentNo').optional().isString(),
    query('customerId').optional().isInt().toInt(),
    query('alertRuleId').optional().isInt().toInt(),
    query('alertLevel').optional().isIn(validAlertLevels),
    query('status').optional().isIn(validStatuses),
    query('probeLocation').optional().isIn(validLocations),
    query('startTime').optional().isISO8601(),
    query('endTime').optional().isISO8601(),
    query('keyword').optional().isString(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const {
        shipmentId, shipmentNo, customerId, alertRuleId,
        alertLevel, status, probeLocation, startTime, endTime, keyword
      } = req.query;

      const where: any = {};

      if (shipmentNo) {
        const s = await prisma.shipment.findUnique({ where: { shipmentNo: shipmentNo as string } });
        if (s) where.shipmentId = s.id;
        else where.shipmentId = -1;
      } else if (shipmentId) {
        where.shipmentId = parseInt(shipmentId as string);
      }
      if (customerId) where.customerId = parseInt(customerId as string);
      if (alertRuleId) where.alertRuleId = parseInt(alertRuleId as string);
      if (alertLevel) where.alertLevel = alertLevel;
      if (status) where.status = status;
      if (probeLocation) where.probeLocation = probeLocation;
      if (startTime || endTime) {
        where.createdAt = {};
        if (startTime) where.createdAt.gte = new Date(startTime as string);
        if (endTime) where.createdAt.lte = new Date(endTime as string);
      }
      if (keyword) {
        where.OR = [
          { probeId: { contains: keyword as string } },
          { handleRemark: { contains: keyword as string } },
          { handleResult: { contains: keyword as string } }
        ];
      }

      const [total, data] = await Promise.all([
        prisma.alertRecord.count({ where }),
        prisma.alertRecord.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
          include: {
            alertRule: { select: { name: true, conditionType: true, thresholdTemp: true, durationMinutes: true } },
            shipment: {
              select: {
                shipmentNo: true, status: true,
                vehicle: { select: { plateNumber: true, vehicleType: true } },
                driver: { select: { realName: true, phone: true } }
              }
            },
            customer: { select: { name: true, code: true } },
            _count: { select: { notifications: true } }
          }
        })
      ]);

      const formatted = data.map(r => ({
        id: r.id,
        alertLevel: r.alertLevel,
        status: r.status,
        probeId: r.probeId,
        probeLocation: r.probeLocation,
        triggerTemp: r.triggerTemp,
        probeComparison: r.probeComparison ? JSON.parse(r.probeComparison) : null,
        durationMinutes: Math.round(r.durationSeconds / 60),
        firstTriggeredAt: r.firstTriggeredAt,
        confirmedAt: r.confirmedAt,
        resolvedAt: r.resolvedAt,
        handledBy: r.handledBy,
        handlerRole: r.handlerRole,
        handleResult: r.handleResult,
        handleRemark: r.handleRemark,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        rule: r.alertRule,
        shipment: r.shipment,
        customer: r.customer,
        notificationCount: r._count.notifications
      }));

      paginatedResponse(res, formatted, page, pageSize, total);
    } catch (error: any) {
      errorResponse(res, error.message, 500);
    }
  }
);

router.get('/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const record = await prisma.alertRecord.findUnique({
      where: { id },
      include: {
        alertRule: true,
        shipment: {
          include: {
            vehicle: true,
            driver: true,
            customer: true
          }
        },
        customer: true,
        notifications: {
          orderBy: { createdAt: 'desc' },
          include: {
            user: { select: { username: true, realName: true, role: true, phone: true } }
          }
        }
      }
    });

    if (!record) return errorResponse(res, '告警记录不存在', 404);

    const windowStart = new Date(record.firstTriggeredAt.getTime() - 15 * 60 * 1000);
    const windowEnd = record.resolvedAt || new Date(record.createdAt.getTime() + 60 * 60 * 1000);

    const historyProbes = await prisma.probeData.findMany({
      where: {
        shipmentId: record.shipmentId,
        collectedAt: { gte: windowStart, lte: windowEnd }
      },
      orderBy: { collectedAt: 'asc' }
    });

    const probeTrend: Record<string, Array<{ time: string; temp: number }>> = {};
    for (const p of historyProbes) {
      const key = `${p.probeLocation}_${p.probeId}`;
      if (!probeTrend[key]) probeTrend[key] = [];
      probeTrend[key].push({
        time: p.collectedAt.toISOString(),
        temp: p.temperature
      });
    }

    successResponse(res, {
      ...record,
      probeComparison: record.probeComparison ? JSON.parse(record.probeComparison) : null,
      alertRule: record.alertRule ? {
        ...record.alertRule,
        notifyRoles: JSON.parse(record.alertRule.notifyRoles)
      } : null,
      probeTrend,
      historyProbeCount: historyProbes.length
    });
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.patch('/:id/acknowledge', [
  param('id').isInt().toInt(),
  body('handledBy').optional().isString(),
  body('handlerRole').optional().isIn(UserRoleArray),
  body('handleRemark').optional().isString(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.alertRecord.findUnique({ where: { id } });
    if (!existing) return errorResponse(res, '告警记录不存在', 404);

    if (![AlertStatus.PENDING, AlertStatus.CONFIRMED].includes(existing.status as any)) {
      return errorResponse(res, `当前状态(${existing.status})不可确认，仅待处理/已确认可操作`, 400);
    }

    const updated = await prisma.alertRecord.update({
      where: { id },
      data: {
        status: AlertStatus.ACKNOWLEDGED,
        handledBy: req.body.handledBy || existing.handledBy || 'SYSTEM',
        handlerRole: req.body.handlerRole || existing.handlerRole || UserRole.OPERATOR,
        handleRemark: req.body.handleRemark || existing.handleRemark || '已接收告警'
      }
    });

    logger.info(`告警 #${id} 已确认: ${req.body.handledBy || 'SYSTEM'}`);
    successResponse(res, updated, '告警已确认接收');
  } catch (error: any) {
    errorResponse(res, error.message, 400);
  }
});

router.patch('/:id/resolve', [
  param('id').isInt().toInt(),
  body('handleResult').isString().withMessage('处理结果必填'),
  body('handleRemark').optional().isString(),
  body('handledBy').optional().isString(),
  body('handlerRole').optional().isIn(UserRoleArray),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.alertRecord.findUnique({ where: { id } });
    if (!existing) return errorResponse(res, '告警记录不存在', 404);

    if (existing.status === AlertStatus.RESOLVED || existing.status === AlertStatus.CLOSED) {
      return errorResponse(res, '告警已完成处理，无需重复操作', 400);
    }

    const updated = await prisma.alertRecord.update({
      where: { id },
      data: {
        status: AlertStatus.RESOLVED,
        resolvedAt: new Date(),
        handleResult: req.body.handleResult,
        handleRemark: req.body.handleRemark,
        handledBy: req.body.handledBy || existing.handledBy || 'SYSTEM',
        handlerRole: req.body.handlerRole || existing.handlerRole || UserRole.OPERATOR
      }
    });

    logger.info(`告警 #${id} 处理完成: ${req.body.handleResult}`);
    successResponse(res, updated, '告警处理完成');
  } catch (error: any) {
    errorResponse(res, error.message, 400);
  }
});

router.patch('/:id/close', [
  param('id').isInt().toInt(),
  body('handleRemark').optional().isString(),
  body('handledBy').optional().isString(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.alertRecord.findUnique({ where: { id } });
    if (!existing) return errorResponse(res, '告警记录不存在', 404);

    const updated = await prisma.alertRecord.update({
      where: { id },
      data: {
        status: AlertStatus.CLOSED,
        resolvedAt: existing.resolvedAt || new Date(),
        handleRemark: req.body.handleRemark || existing.handleRemark || '告警已关闭',
        handledBy: req.body.handledBy || existing.handledBy || 'SYSTEM'
      }
    });

    logger.info(`告警 #${id} 已关闭`);
    successResponse(res, updated, '告警已关闭');
  } catch (error: any) {
    errorResponse(res, error.message, 400);
  }
});

router.patch('/:id/false-alarm', [
  param('id').isInt().toInt(),
  body('handleRemark').optional().isString(),
  body('handledBy').optional().isString(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.alertRecord.findUnique({ where: { id } });
    if (!existing) return errorResponse(res, '告警记录不存在', 404);

    const updated = await prisma.alertRecord.update({
      where: { id },
      data: {
        status: AlertStatus.FALSE_ALARM,
        resolvedAt: new Date(),
        handleResult: 'FALSE_ALARM',
        handleRemark: req.body.handleRemark || '确认为误报',
        handledBy: req.body.handledBy || existing.handledBy || 'SYSTEM'
      }
    });

    logger.info(`告警 #${id} 标记为误报`);
    successResponse(res, updated, '已标记为误报');
  } catch (error: any) {
    errorResponse(res, error.message, 400);
  }
});

router.post('/:id/re-notify', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const record = await prisma.alertRecord.findUnique({
      where: { id },
      include: {
        alertRule: true,
        shipment: { include: { customer: true, vehicle: true, driver: true } },
        customer: true
      }
    });

    if (!record || !record.alertRule) {
      return errorResponse(res, '告警记录或规则不存在', 404);
    }

    const shipment = record.shipment as any;
    const ctx = {
      shipment,
      allProbes: [],
      latestByLocation: new Map(),
      triggeredAt: new Date()
    };

    await notificationService.dispatchNotifications(record, record.alertRule, ctx as any);

    logger.info(`告警 #${id} 重新派发通知`);
    successResponse(res, { alertId: id, reNotified: true }, '通知重发成功');
  } catch (error: any) {
    logger.error('重发通知失败:', error);
    errorResponse(res, `重发失败: ${error.message}`, 500);
  }
});

router.get('/stats/summary', [
  query('startTime').optional().isISO8601(),
  query('endTime').optional().isISO8601(),
  query('customerId').optional().isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const { startTime, endTime, customerId } = req.query;
    const where: any = {};
    if (startTime || endTime) {
      where.createdAt = {};
      if (startTime) where.createdAt.gte = new Date(startTime as string);
      if (endTime) where.createdAt.lte = new Date(endTime as string);
    }
    if (customerId) where.customerId = parseInt(customerId as string);

    const [total, byLevel, byStatus, pendingList] = await Promise.all([
      prisma.alertRecord.count({ where }),
      prisma.alertRecord.groupBy({
        by: ['alertLevel'],
        where,
        _count: { id: true }
      }),
      prisma.alertRecord.groupBy({
        by: ['status'],
        where,
        _count: { id: true }
      }),
      prisma.alertRecord.findMany({
        where: {
          ...where,
          status: { in: [AlertStatus.PENDING, AlertStatus.CONFIRMED, AlertStatus.ACKNOWLEDGED] }
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: {
          shipment: { select: { shipmentNo: true, vehicle: { select: { plateNumber: true } } } },
          customer: { select: { name: true } },
          alertRule: { select: { name: true } }
        }
      })
    ]);

    successResponse(res, {
      total,
      byLevel: Object.fromEntries(byLevel.map(x => [x.alertLevel, x._count.id])),
      byStatus: Object.fromEntries(byStatus.map(x => [x.status, x._count.id])),
      activeAlerts: pendingList,
      autoRecoveryRate: total > 0 ? {
        autoRecovered: (await prisma.alertRecord.count({
          where: { ...where, handleResult: 'AUTO_RECOVERED' }
        }))
      } : null
    });
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.post('/shipment/:shipmentId/re-evaluate', [
  param('shipmentId').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const shipmentId = parseInt(req.params.shipmentId);
    const shipment = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: { customer: true, vehicle: true }
    });
    if (!shipment) return errorResponse(res, '车次不存在', 404);

    const recentProbes = await prisma.probeData.findMany({
      where: {
        shipmentId,
        collectedAt: { gte: new Date(Date.now() - 60 * 60 * 1000) }
      },
      orderBy: { collectedAt: 'desc' },
      take: 500
    });

    const results = await alertEngine.processProbeData(recentProbes);

    successResponse(res, {
      shipmentId,
      evaluatedProbeCount: recentProbes.length,
      triggeredAlerts: results.filter(r => r.triggered).length,
      details: results.filter(r => r.triggered).map(r => ({
        ruleId: r.matchedRule?.id,
        ruleName: r.matchedRule?.name,
        level: r.alertLevel,
        temp: r.triggerProbe?.temperature,
        durationMin: Math.round((r.durationSeconds || 0) / 60)
      }))
    });
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

export default router;
