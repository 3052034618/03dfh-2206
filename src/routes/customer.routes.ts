import { Router, Request, Response } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../config/prisma';
import { validateRequest, parsePagination } from '../middleware/validate';
import { successResponse, paginatedResponse, errorResponse } from '../utils/response';
import logger from '../utils/logger';

const router = Router();

router.post(
  '/',
  [
    body('name').isString().isLength({ min: 2, max: 100 }).withMessage('客户名称2-100字符'),
    body('code').isString().isLength({ min: 2, max: 50 }).withMessage('客户编码2-50字符'),
    body('contactPerson').optional().isString(),
    body('contactPhone').optional().isString(),
    body('wechatGroup').optional().isString(),
    body('isActive').optional().isBoolean(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const customer = await prisma.customer.create({ data: req.body });
      logger.info(`创建客户 #${customer.id}: ${customer.name}`);
      successResponse(res, customer, '客户创建成功', 201);
    } catch (error: any) {
      errorResponse(res, `创建失败: ${error.message}`, 400);
    }
  }
);

router.get(
  '/',
  [
    query('isActive').optional().isBoolean().toBoolean(),
    query('keyword').optional().isString(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { isActive, keyword } = req.query;

      const where: any = {};
      if (isActive !== undefined) where.isActive = isActive === 'true';
      if (keyword) {
        where.OR = [
          { name: { contains: keyword as string } },
          { code: { contains: keyword as string } },
          { contactPerson: { contains: keyword as string } }
        ];
      }

      const [total, data] = await Promise.all([
        prisma.customer.count({ where }),
        prisma.customer.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
          include: {
            _count: {
              select: { shipments: true, alertRules: true, alertRecords: true, users: true }
            }
          }
        })
      ]);

      const formatted = data.map(c => ({
        ...c,
        stats: c._count
      }));

      paginatedResponse(res, formatted, page, pageSize, total);
    } catch (error: any) {
      errorResponse(res, error.message, 500);
    }
  }
);

router.get('/list/simple', async (_req: Request, res: Response) => {
  try {
    const customers = await prisma.customer.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: 'asc' }
    });
    successResponse(res, customers);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.get('/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        shipments: { take: 10, orderBy: { createdAt: 'desc' } },
        alertRules: { take: 20, orderBy: { priority: 'desc' } },
        users: { select: { id: true, username: true, realName: true, role: true, phone: true } },
        _count: { select: { alertRecords: true } }
      }
    });

    if (!customer) return errorResponse(res, '客户不存在', 404);
    successResponse(res, customer);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.put(
  '/:id',
  [
    param('id').isInt().toInt(),
    body('name').optional().isString().isLength({ min: 2, max: 100 }),
    body('code').optional().isString().isLength({ min: 2, max: 50 }),
    body('contactPerson').optional().isString(),
    body('contactPhone').optional().isString(),
    body('wechatGroup').optional().isString(),
    body('isActive').optional().isBoolean(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const customer = await prisma.customer.update({
        where: { id },
        data: req.body
      });
      logger.info(`更新客户 #${id}`);
      successResponse(res, customer, '客户更新成功');
    } catch (error: any) {
      errorResponse(res, `更新失败: ${error.message}`, 400);
    }
  }
);

router.delete('/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const [shipmentCount, ruleCount, recordCount] = await Promise.all([
      prisma.shipment.count({ where: { customerId: id } }),
      prisma.alertRule.count({ where: { customerId: id } }),
      prisma.alertRecord.count({ where: { customerId: id } })
    ]);

    if (shipmentCount > 0 || ruleCount > 0 || recordCount > 0) {
      return errorResponse(res,
        `客户关联数据存在: 车次${shipmentCount}, 规则${ruleCount}, 告警${recordCount}，无法删除`,
        400
      );
    }

    await prisma.customer.delete({ where: { id } });
    logger.info(`删除客户 #${id}`);
    successResponse(res, null, '删除成功');
  } catch (error: any) {
    errorResponse(res, `删除失败: ${error.message}`, 400);
  }
});

export default router;
