import { Router, Request, Response } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../config/prisma';
import { validateRequest, parsePagination } from '../middleware/validate';
import { successResponse, paginatedResponse, errorResponse } from '../utils/response';
import logger from '../utils/logger';
import { TemperatureZoneArray } from '../types/enums';

const router = Router();
const validZones = TemperatureZoneArray;
const validStatuses = ['PENDING', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'];

router.post(
  '/',
  [
    body('shipmentNo').isString().isLength({ min: 6, max: 50 }).withMessage('车次号6-50字符'),
    body('customerId').isInt().toInt().withMessage('客户ID必填'),
    body('vehicleId').isInt().toInt().withMessage('车辆ID必填'),
    body('driverId').optional().isInt().toInt(),
    body('temperatureZone').isIn(validZones).withMessage(`温区必须是: ${validZones.join(',')}`),
    body('cargoDescription').optional().isString(),
    body('targetTempMin').optional().isNumeric(),
    body('targetTempMax').optional().isNumeric(),
    body('startTime').optional().isISO8601(),
    body('endTime').optional().isISO8601(),
    body('status').optional().isIn(validStatuses),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { customerId, vehicleId, driverId, startTime, endTime } = req.body;

      const [customer, vehicle] = await Promise.all([
        prisma.customer.findUnique({ where: { id: customerId } }),
        prisma.vehicle.findUnique({ where: { id: vehicleId } })
      ]);
      if (!customer) return errorResponse(res, '客户不存在', 404);
      if (!vehicle) return errorResponse(res, '车辆不存在', 404);
      if (driverId) {
        const driver = await prisma.user.findUnique({ where: { id: driverId } });
        if (!driver) return errorResponse(res, '司机不存在', 404);
        if (driver.role !== 'DRIVER') return errorResponse(res, '指定用户不是司机角色', 400);
      }

      const data = {
        ...req.body,
        startTime: startTime ? new Date(startTime) : undefined,
        endTime: endTime ? new Date(endTime) : undefined
      };

      const shipment = await prisma.shipment.create({ data });
      logger.info(`创建车次: ${shipment.shipmentNo}`);
      successResponse(res, shipment, '车次创建成功', 201);
    } catch (error: any) {
      errorResponse(res, `创建失败: ${error.message}`, 400);
    }
  }
);

router.get(
  '/',
  [
    query('customerId').optional().isInt().toInt(),
    query('vehicleId').optional().isInt().toInt(),
    query('driverId').optional().isInt().toInt(),
    query('temperatureZone').optional().isIn(validZones),
    query('status').optional().isIn(validStatuses),
    query('startTimeFrom').optional().isISO8601(),
    query('startTimeTo').optional().isISO8601(),
    query('keyword').optional().isString(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const {
        customerId, vehicleId, driverId, temperatureZone, status,
        startTimeFrom, startTimeTo, keyword
      } = req.query;

      const where: any = {};
      if (customerId) where.customerId = parseInt(customerId as string);
      if (vehicleId) where.vehicleId = parseInt(vehicleId as string);
      if (driverId) where.driverId = parseInt(driverId as string);
      if (temperatureZone) where.temperatureZone = temperatureZone;
      if (status) where.status = status;
      if (startTimeFrom || startTimeTo) {
        where.startTime = {};
        if (startTimeFrom) where.startTime.gte = new Date(startTimeFrom as string);
        if (startTimeTo) where.startTime.lte = new Date(startTimeTo as string);
      }
      if (keyword) {
        where.OR = [
          { shipmentNo: { contains: keyword as string } },
          { cargoDescription: { contains: keyword as string } }
        ];
      }

      const [total, data] = await Promise.all([
        prisma.shipment.count({ where }),
        prisma.shipment.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
          include: {
            customer: { select: { id: true, name: true, code: true } },
            vehicle: { select: { id: true, plateNumber: true, vehicleType: true } },
            driver: { select: { id: true, username: true, realName: true, phone: true } },
            _count: { select: { probeData: true, alertRecords: true } }
          }
        })
      ]);

      const formatted = data.map(s => ({
        ...s,
        probeDataCount: s._count.probeData,
        alertCount: s._count.alertRecords
      }));

      paginatedResponse(res, formatted, page, pageSize, total);
    } catch (error: any) {
      errorResponse(res, error.message, 500);
    }
  }
);

router.get('/active', async (_req: Request, res: Response) => {
  try {
    const shipments = await prisma.shipment.findMany({
      where: { status: 'IN_TRANSIT' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        customer: { select: { name: true } },
        vehicle: { select: { plateNumber: true, vehicleType: true } },
        driver: { select: { realName: true, phone: true } },
        _count: { select: { alertRecords: true } }
      }
    });

    const withAlerts = shipments.map(s => ({
      ...s,
      pendingAlertCount: s._count.alertRecords
    }));

    successResponse(res, {
      total: shipments.length,
      list: withAlerts
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
    const shipment = await prisma.shipment.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        customer: true,
        vehicle: true,
        driver: { select: { id: true, username: true, realName: true, phone: true } },
        alertRecords: {
          orderBy: { createdAt: 'desc' },
          include: { alertRule: { select: { name: true, alertLevel: true } } }
        }
      }
    });
    if (!shipment) return errorResponse(res, '车次不存在', 404);
    successResponse(res, shipment);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.put(
  '/:id',
  [
    param('id').isInt().toInt(),
    body('driverId').optional().isInt().toInt(),
    body('temperatureZone').optional().isIn(validZones),
    body('cargoDescription').optional().isString(),
    body('targetTempMin').optional().isNumeric(),
    body('targetTempMax').optional().isNumeric(),
    body('startTime').optional().isISO8601(),
    body('endTime').optional().isISO8601(),
    body('status').optional().isIn(validStatuses),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const data = { ...req.body };
      if (data.startTime) data.startTime = new Date(data.startTime);
      if (data.endTime) data.endTime = new Date(data.endTime);

      const shipment = await prisma.shipment.update({ where: { id }, data });
      logger.info(`更新车次: ${shipment.shipmentNo} -> ${shipment.status}`);
      successResponse(res, shipment, '车次更新成功');
    } catch (error: any) {
      errorResponse(res, `更新失败: ${error.message}`, 400);
    }
  }
);

router.patch('/:shipmentNo/status', [
  param('shipmentNo').isString(),
  body('status').isIn(validStatuses).withMessage('状态值无效'),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const { shipmentNo } = req.params;
    const existing = await prisma.shipment.findUnique({ where: { shipmentNo } });
    if (!existing) return errorResponse(res, '车次不存在', 404);

    const data: any = { status: req.body.status };
    if (req.body.status === 'COMPLETED') {
      data.endTime = new Date();
    }

    const shipment = await prisma.shipment.update({
      where: { shipmentNo },
      data
    });
    logger.info(`车次状态变更: ${shipmentNo} -> ${req.body.status}`);
    successResponse(res, shipment, '状态更新成功');
  } catch (error: any) {
    errorResponse(res, `更新失败: ${error.message}`, 400);
  }
});

router.get('/no/:shipmentNo', [
  param('shipmentNo').isString(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const shipment = await prisma.shipment.findUnique({
      where: { shipmentNo: req.params.shipmentNo },
      include: {
        customer: { select: { name: true, code: true } },
        vehicle: true,
        driver: { select: { realName: true, phone: true } }
      }
    });
    if (!shipment) return errorResponse(res, '车次不存在', 404);
    successResponse(res, shipment);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

export default router;
