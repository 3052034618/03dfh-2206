import { Router, Request, Response } from 'express';
import prisma from '../config/prisma';
import { successResponse, errorResponse } from '../utils/response';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  try {
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1 as alive`;
    const dbLatency = Date.now() - dbStart;

    successResponse(res, {
      status: 'healthy',
      uptime: process.uptime(),
      database: {
        status: 'connected',
        latencyMs: dbLatency
      },
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    errorResponse(res, `健康检查失败: ${error.message}`, 503);
  }
});

router.get('/stats', async (req: Request, res: Response) => {
  try {
    const [customers, vehicles, shipments, rules, records, probes] = await Promise.all([
      prisma.customer.count(),
      prisma.vehicle.count(),
      prisma.shipment.count(),
      prisma.alertRule.count(),
      prisma.alertRecord.count(),
      prisma.probeData.count()
    ]);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayRecords = await prisma.alertRecord.count({
      where: { createdAt: { gte: todayStart } }
    });
    const todayProbes = await prisma.probeData.count({
      where: { createdAt: { gte: todayStart } }
    });

    successResponse(res, {
      customers,
      vehicles,
      activeShipments: shipments,
      alertRules: rules,
      totalAlertRecords: records,
      totalProbeData: probes,
      today: {
        alertRecords: todayRecords,
        probeDataPoints: todayProbes
      }
    });
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

export default router;
