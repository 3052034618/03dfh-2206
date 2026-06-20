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
    body('plateNumber').isString().isLength({ min: 6, max: 20 }).withMessage('车牌号6-20字符'),
    body('vehicleType').isString().withMessage('车型必填'),
    body('gpsDeviceId').optional().isString(),
    body('isActive').optional().isBoolean(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const vehicle = await prisma.vehicle.create({ data: req.body });
      logger.info(`创建车辆 #${vehicle.id}: ${vehicle.plateNumber}`);
      successResponse(res, vehicle, '车辆创建成功', 201);
    } catch (error: any) {
      errorResponse(res, `创建失败: ${error.message}`, 400);
    }
  }
);

router.get(
  '/',
  [
    query('vehicleType').optional().isString(),
    query('isActive').optional().isBoolean().toBoolean(),
    query('keyword').optional().isString(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { vehicleType, isActive, keyword } = req.query;

      const where: any = {};
      if (vehicleType) where.vehicleType = vehicleType;
      if (isActive !== undefined) where.isActive = isActive === 'true';
      if (keyword) {
        where.OR = [
          { plateNumber: { contains: keyword as string } },
          { vehicleType: { contains: keyword as string } },
          { gpsDeviceId: { contains: keyword as string } }
        ];
      }

      const [total, data] = await Promise.all([
        prisma.vehicle.count({ where }),
        prisma.vehicle.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
          include: {
            _count: { select: { shipments: true } }
          }
        })
      ]);

      const formatted = data.map(v => ({
        ...v,
        shipmentCount: v._count.shipments
      }));

      paginatedResponse(res, formatted, page, pageSize, total);
    } catch (error: any) {
      errorResponse(res, error.message, 500);
    }
  }
);

router.get('/list/simple', async (_req: Request, res: Response) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { isActive: true },
      select: { id: true, plateNumber: true, vehicleType: true },
      orderBy: { plateNumber: 'asc' }
    });
    successResponse(res, vehicles);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.get('/types', async (_req: Request, res: Response) => {
  try {
    const result = await prisma.vehicle.groupBy({
      by: ['vehicleType'],
      _count: { id: true }
    });
    successResponse(res, result.map(r => ({
      type: r.vehicleType,
      count: r._count.id
    })));
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.get('/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        shipments: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: {
            customer: { select: { name: true } },
            driver: { select: { realName: true } }
          }
        }
      }
    });
    if (!vehicle) return errorResponse(res, '车辆不存在', 404);
    successResponse(res, vehicle);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.put(
  '/:id',
  [
    param('id').isInt().toInt(),
    body('plateNumber').optional().isString().isLength({ min: 6, max: 20 }),
    body('vehicleType').optional().isString(),
    body('gpsDeviceId').optional().isString(),
    body('isActive').optional().isBoolean(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const vehicle = await prisma.vehicle.update({ where: { id }, data: req.body });
      logger.info(`更新车辆 #${id}: ${vehicle.plateNumber}`);
      successResponse(res, vehicle, '车辆更新成功');
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
    const shipmentCount = await prisma.shipment.count({ where: { vehicleId: id } });
    if (shipmentCount > 0) {
      return errorResponse(res, `车辆存在关联车次(${shipmentCount})，无法删除`, 400);
    }
    await prisma.vehicle.delete({ where: { id } });
    logger.info(`删除车辆 #${id}`);
    successResponse(res, null, '删除成功');
  } catch (error: any) {
    errorResponse(res, `删除失败: ${error.message}`, 400);
  }
});

export default router;
