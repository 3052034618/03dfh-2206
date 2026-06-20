import { Router, Request, Response } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../config/prisma';
import { validateRequest, parsePagination } from '../middleware/validate';
import { successResponse, paginatedResponse, errorResponse } from '../utils/response';
import logger from '../utils/logger';
import { AlertLevelArray, ProbeLocationArray, TemperatureZoneArray } from '../types/enums';

const router = Router();

const validAlertLevels = AlertLevelArray;
const validProbeLocations = ProbeLocationArray;
const validZones = TemperatureZoneArray;
const validConditionTypes = [
  'TEMPERATURE_ABOVE',
  'TEMPERATURE_BELOW',
  'TEMPERATURE_SPIKE_WITH_COMPARE',
  'DIFF_WITH_COMPARE',
  'ANY_ABOVE'
];
const validOperators = ['>', '<', '>=', '<=', '==', '!='];

const ruleValidator = [
  body('name').isString().isLength({ min: 2, max: 100 }).withMessage('规则名称2-100字符'),
  body('description').optional().isString().isLength({ max: 500 }),
  body('customerId').optional().isInt().toInt().withMessage('客户ID必须为整数'),
  body('vehicleType').optional().isString(),
  body('temperatureZone').optional().isIn(validZones).withMessage('温区无效'),
  body('probeLocation').isIn(validProbeLocations).withMessage('探头位置无效'),
  body('conditionType').isIn(validConditionTypes).withMessage('条件类型无效'),
  body('operator').isIn(validOperators).withMessage('操作符无效'),
  body('thresholdTemp').isNumeric().withMessage('阈值温度必须为数字'),
  body('compareProbeLocation').optional().isIn(validProbeLocations),
  body('compareThreshold').optional().isNumeric(),
  body('durationMinutes').optional().isInt({ min: 0 }).toInt().withMessage('持续时间必须为非负整数'),
  body('alertLevel').isIn(validAlertLevels).withMessage('告警级别无效'),
  body('notifyRoles').custom((value) => {
    try {
      const arr = typeof value === 'string' ? JSON.parse(value) : value;
      if (!Array.isArray(arr)) throw new Error('通知角色必须是数组');
      return true;
    } catch (e: any) {
      throw new Error('通知角色格式错误: ' + e.message);
    }
  }),
  body('isActive').optional().isBoolean(),
  body('priority').optional().isInt().toInt()
];

router.post(
  '/',
  [...ruleValidator, validateRequest],
  async (req: Request, res: Response) => {
    try {
      const data = { ...req.body };
      if (typeof data.notifyRoles === 'string') {
        data.notifyRoles = JSON.parse(data.notifyRoles);
      }
      data.notifyRoles = JSON.stringify(data.notifyRoles);

      if (data.customerId) {
        const customer = await prisma.customer.findUnique({ where: { id: data.customerId } });
        if (!customer) return errorResponse(res, '客户不存在', 404);
      }

      const rule = await prisma.alertRule.create({ data });
      logger.info(`创建告警规则 #${rule.id}: ${rule.name}`);
      successResponse(res, rule, '规则创建成功', 201);
    } catch (error: any) {
      logger.error('创建规则失败:', error);
      errorResponse(res, `创建失败: ${error.message}`, 400);
    }
  }
);

router.get(
  '/',
  [
    query('customerId').optional().isInt().toInt(),
    query('temperatureZone').optional().isIn(validZones),
    query('probeLocation').optional().isIn(validProbeLocations),
    query('alertLevel').optional().isIn(validAlertLevels),
    query('isActive').optional().isBoolean().toBoolean(),
    query('keyword').optional().isString(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { customerId, temperatureZone, probeLocation, alertLevel, isActive, keyword } = req.query;

      const where: any = {};
      if (customerId !== undefined) where.customerId = parseInt(customerId as string);
      if (temperatureZone) where.temperatureZone = temperatureZone;
      if (probeLocation) where.probeLocation = probeLocation;
      if (alertLevel) where.alertLevel = alertLevel;
      if (isActive !== undefined) where.isActive = isActive === 'true';
      if (keyword) {
        where.OR = [
          { name: { contains: keyword as string } },
          { description: { contains: keyword as string } }
        ];
      }

      const [total, data] = await Promise.all([
        prisma.alertRule.count({ where }),
        prisma.alertRule.findMany({
          where,
          orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
          skip,
          take: pageSize,
          include: {
            customer: { select: { name: true, code: true } },
            _count: {
              select: { alertRecords: true }
            }
          }
        })
      ]);

      const formatted = data.map(r => ({
        ...r,
        notifyRoles: JSON.parse(r.notifyRoles),
        triggerCount: r._count.alertRecords
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
    const rule = await prisma.alertRule.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        customer: { select: { name: true, code: true } },
        alertRecords: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            shipment: { select: { shipmentNo: true } }
          }
        }
      }
    });

    if (!rule) return errorResponse(res, '规则不存在', 404);

    successResponse(res, {
      ...rule,
      notifyRoles: JSON.parse(rule.notifyRoles)
    });
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.put(
  '/:id',
  [
    param('id').isInt().toInt(),
    ...ruleValidator,
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await prisma.alertRule.findUnique({ where: { id } });
      if (!existing) return errorResponse(res, '规则不存在', 404);

      const data = { ...req.body };
      if (typeof data.notifyRoles === 'string') {
        data.notifyRoles = JSON.parse(data.notifyRoles);
      }
      data.notifyRoles = JSON.stringify(data.notifyRoles);

      const rule = await prisma.alertRule.update({ where: { id }, data });
      logger.info(`更新告警规则 #${rule.id}: ${rule.name}`);
      successResponse(res, {
        ...rule,
        notifyRoles: JSON.parse(rule.notifyRoles)
      }, '规则更新成功');
    } catch (error: any) {
      logger.error('更新规则失败:', error);
      errorResponse(res, `更新失败: ${error.message}`, 400);
    }
  }
);

router.patch(
  '/:id/status',
  [
    param('id').isInt().toInt(),
    body('isActive').isBoolean().withMessage('isActive必填布尔值'),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const existing = await prisma.alertRule.findUnique({ where: { id } });
      if (!existing) return errorResponse(res, '规则不存在', 404);

      const rule = await prisma.alertRule.update({
        where: { id },
        data: { isActive: req.body.isActive }
      });

      logger.info(`${rule.isActive ? '启用' : '停用'}规则 #${rule.id}`);
      successResponse(res, rule, `规则已${rule.isActive ? '启用' : '停用'}`);
    } catch (error: any) {
      errorResponse(res, error.message, 400);
    }
  }
);

router.delete('/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.alertRule.findUnique({ where: { id } });
    if (!existing) return errorResponse(res, '规则不存在', 404);

    const inUse = await prisma.alertRecord.count({ where: { alertRuleId: id } });
    if (inUse > 0) {
      return errorResponse(res, `规则正在使用中(关联${inUse}条告警记录)，无法删除`, 400);
    }

    await prisma.alertRule.delete({ where: { id } });
    logger.info(`删除规则 #${id}: ${existing.name}`);
    successResponse(res, null, '规则删除成功');
  } catch (error: any) {
    errorResponse(res, `删除失败: ${error.message}`, 400);
  }
});

router.post('/clone/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const source = await prisma.alertRule.findUnique({ where: { id } });
    if (!source) return errorResponse(res, '源规则不存在', 404);

    const cloned = await prisma.alertRule.create({
      data: {
        name: `${source.name} (副本)`,
        description: source.description,
        customerId: source.customerId,
        vehicleType: source.vehicleType,
        temperatureZone: source.temperatureZone,
        probeLocation: source.probeLocation,
        conditionType: source.conditionType,
        operator: source.operator,
        thresholdTemp: source.thresholdTemp,
        compareProbeLocation: source.compareProbeLocation,
        compareThreshold: source.compareThreshold,
        durationMinutes: source.durationMinutes,
        alertLevel: source.alertLevel,
        notifyRoles: source.notifyRoles,
        priority: source.priority,
        isActive: false
      }
    });

    logger.info(`克隆规则 #${id} -> #${cloned.id}`);
    successResponse(res, {
      ...cloned,
      notifyRoles: JSON.parse(cloned.notifyRoles)
    }, '规则克隆成功', 201);
  } catch (error: any) {
    errorResponse(res, `克隆失败: ${error.message}`, 400);
  }
});

router.get('/meta/enums', (_req: Request, res: Response) => {
  successResponse(res, {
    alertLevels: validAlertLevels,
    probeLocations: validProbeLocations,
    temperatureZones: validZones,
    conditionTypes: validConditionTypes,
    operators: validOperators
  });
});

export default router;
