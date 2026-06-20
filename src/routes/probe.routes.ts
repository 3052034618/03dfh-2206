import { Router, Request, Response } from 'express';
import { body, query } from 'express-validator';
import prisma from '../config/prisma';
import { validateRequest, parsePagination } from '../middleware/validate';
import { successResponse, paginatedResponse, errorResponse } from '../utils/response';
import { alertEngine, AlertResult } from '../services/alertEngine.service';
import logger from '../utils/logger';
import { ProbeLocationArray } from '../types/enums';

const router = Router();

const validLocations = ProbeLocationArray;

function formatAlertItem(r: AlertResult) {
  return {
    level: r.alertLevel,
    ruleId: r.matchedRule?.id,
    ruleName: r.matchedRule?.name,
    probe: r.triggerProbe?.probeId,
    temperature: r.triggerProbe?.temperature,
    durationSeconds: r.durationSeconds,
    triggeredProbeCount: r.triggeredProbes?.length || 1,
    triggeredProbes: r.triggeredProbes?.map(tp => ({
      probeId: tp.probeId,
      temperature: tp.temperature,
      durationSeconds: tp.durationSeconds
    })),
    probesByLocation: r.probeComparison?.probesByLocation
  };
}

router.post(
  '/ingest',
  [
    body('shipmentNo').isString().withMessage('车次号必填'),
    body('data').isArray({ min: 1 }).withMessage('探头数据数组必填'),
    body('data.*.probeId').isString().withMessage('探头ID必填'),
    body('data.*.probeLocation').isIn(validLocations).withMessage(`探头位置必须是: ${validLocations.join(',')}`),
    body('data.*.temperature').isNumeric().withMessage('温度必须为数字'),
    body('data.*.collectedAt').optional().isISO8601().withMessage('采集时间格式不正确'),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { shipmentNo, data } = req.body;

      const shipment = await prisma.shipment.findUnique({
        where: { shipmentNo }
      });

      if (!shipment) {
        return errorResponse(res, `车次 ${shipmentNo} 不存在`, 404);
      }

      const probeRecords = data.map((item: any) => ({
        shipmentId: shipment.id,
        probeId: item.probeId,
        probeLocation: item.probeLocation,
        temperature: parseFloat(item.temperature),
        humidity: item.humidity != null ? parseFloat(item.humidity) : null,
        latitude: item.latitude != null ? parseFloat(item.latitude) : null,
        longitude: item.longitude != null ? parseFloat(item.longitude) : null,
        batteryLevel: item.batteryLevel != null ? parseFloat(item.batteryLevel) : null,
        signalStrength: item.signalStrength != null ? parseInt(item.signalStrength) : null,
        collectedAt: item.collectedAt ? new Date(item.collectedAt) : new Date()
      }));

      const created = await prisma.probeData.createMany({
        data: probeRecords
      });

      logger.info(`接收探头数据: 车次=${shipmentNo}, 数量=${created.count}`);

      const results = await alertEngine.processProbeData(probeRecords.map((r: any, _i: number) => ({
        id: -1,
        ...r,
        createdAt: new Date()
      })));

      return successResponse(res, {
        received: created.count,
        shipmentNo,
        shipmentId: shipment.id,
        alertsTriggered: results.filter(r => r.triggered).length,
        alerts: results.filter(r => r.triggered).map(formatAlertItem)
      }, '探头数据接收成功');
    } catch (error: any) {
      logger.error('探头数据接收失败:', error);
      return errorResponse(res, `接收失败: ${error.message}`, 500);
    }
  }
);

router.post(
  '/batch',
  [
    body('records').isArray({ min: 1 }).withMessage('批量记录数组必填'),
    body('records.*.shipmentNo').isString().withMessage('车次号必填'),
    body('records.*.probeId').isString().withMessage('探头ID必填'),
    body('records.*.probeLocation').isIn(validLocations).withMessage('探头位置无效'),
    body('records.*.temperature').isNumeric().withMessage('温度必须为数字'),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { records } = req.body;

      const shipmentNos: string[] = [...new Set<string>(records.map((r: any) => r.shipmentNo as string))];
      const shipments = await prisma.shipment.findMany({
        where: { shipmentNo: { in: shipmentNos } },
        select: { id: true, shipmentNo: true }
      });
      const shipmentMap = new Map(shipments.map(s => [s.shipmentNo, s.id]));

      const invalidShipments = shipmentNos.filter((n: string) => !shipmentMap.has(n));
      if (invalidShipments.length > 0) {
        return errorResponse(res, `以下车次不存在: ${invalidShipments.join(', ')}`, 400);
      }

      const probeData = records.map((item: any) => ({
        shipmentId: shipmentMap.get(item.shipmentNo)!,
        probeId: item.probeId,
        probeLocation: item.probeLocation,
        temperature: parseFloat(item.temperature),
        humidity: item.humidity != null ? parseFloat(item.humidity) : null,
        latitude: item.latitude != null ? parseFloat(item.latitude) : null,
        longitude: item.longitude != null ? parseFloat(item.longitude) : null,
        batteryLevel: item.batteryLevel != null ? parseFloat(item.batteryLevel) : null,
        signalStrength: item.signalStrength != null ? parseInt(item.signalStrength) : null,
        collectedAt: item.collectedAt ? new Date(item.collectedAt) : new Date()
      }));

      const created = await prisma.probeData.createMany({
        data: probeData
      });

      const alerts = await alertEngine.processProbeData(probeData.map((p: any) => ({
        id: -1,
        ...p,
        createdAt: new Date()
      })));

      logger.info(`批量接收探头数据: ${created.count}条, 触发${alerts.filter(a => a.triggered).length}个告警`);

      const triggeredAlerts = alerts.filter(a => a.triggered);

      const shipmentSummary: Record<string, any> = {};
      for (const no of shipmentNos) {
        const id = shipmentMap.get(no)!;
        const shipAlerts = triggeredAlerts.filter(a => a.shipmentId === id);
        shipmentSummary[no] = {
          shipmentId: id,
          probesReceived: records.filter((r: any) => r.shipmentNo === no).length,
          alertsTriggered: shipAlerts.length,
          alerts: shipAlerts.map(formatAlertItem)
        };
      }

      successResponse(res, {
        received: created.count,
        shipmentCount: shipmentNos.length,
        alertsTriggered: triggeredAlerts.length,
        shipmentSummary,
        alerts: triggeredAlerts.map(formatAlertItem)
      }, '批量接收成功');
    } catch (error: any) {
      logger.error('批量接收失败:', error);
      errorResponse(res, `批量接收失败: ${error.message}`, 500);
    }
  }
);

router.get(
  '/',
  [
    query('shipmentId').optional().isInt().toInt(),
    query('shipmentNo').optional().isString(),
    query('probeId').optional().isString(),
    query('probeLocation').optional().isIn(validLocations),
    query('startTime').optional().isISO8601(),
    query('endTime').optional().isISO8601(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { shipmentId, shipmentNo, probeId, probeLocation, startTime, endTime } = req.query;

      const where: any = {};

      if (shipmentNo) {
        const s = await prisma.shipment.findUnique({ where: { shipmentNo: shipmentNo as string } });
        if (s) where.shipmentId = s.id;
      } else if (shipmentId) {
        where.shipmentId = parseInt(shipmentId as string);
      }
      if (probeId) where.probeId = probeId;
      if (probeLocation) where.probeLocation = probeLocation;
      if (startTime || endTime) {
        where.collectedAt = {};
        if (startTime) where.collectedAt.gte = new Date(startTime as string);
        if (endTime) where.collectedAt.lte = new Date(endTime as string);
      }

      const [total, data] = await Promise.all([
        prisma.probeData.count({ where }),
        prisma.probeData.findMany({
          where,
          orderBy: { collectedAt: 'desc' },
          skip,
          take: pageSize,
          include: {
            shipment: {
              select: { shipmentNo: true, status: true }
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

router.get('/shipment/:shipmentNo/summary', async (req: Request, res: Response) => {
  try {
    const { shipmentNo } = req.params;
    const shipment = await prisma.shipment.findUnique({ where: { shipmentNo } });
    if (!shipment) return errorResponse(res, '车次不存在', 404);

    const windowStart = new Date(Date.now() - 60 * 60 * 1000);
    const probeData = await prisma.probeData.findMany({
      where: {
        shipmentId: shipment.id,
        collectedAt: { gte: windowStart }
      },
      orderBy: { collectedAt: 'desc' }
    });

    const byLocation: Record<string, any> = {};
    for (const d of probeData) {
      if (!byLocation[d.probeLocation]) {
        byLocation[d.probeLocation] = { probes: {}, latest: null };
      }
      if (!byLocation[d.probeLocation].probes[d.probeId]) {
        byLocation[d.probeLocation].probes[d.probeId] = {
          latest: d,
          count: 0,
          temps: []
        };
      }
      const p = byLocation[d.probeLocation].probes[d.probeId];
      p.count++;
      p.temps.push(d.temperature);
      if (!p.latest || new Date(d.collectedAt) > new Date(p.latest.collectedAt)) {
        p.latest = d;
      }
    }

    for (const loc of Object.keys(byLocation)) {
      for (const pid of Object.keys(byLocation[loc].probes)) {
        const p = byLocation[loc].probes[pid];
        p.avgTemp = p.temps.length ? (p.temps.reduce((a: number, b: number) => a + b, 0) / p.temps.length).toFixed(2) : 0;
        p.minTemp = p.temps.length ? Math.min(...p.temps).toFixed(2) : 0;
        p.maxTemp = p.temps.length ? Math.max(...p.temps).toFixed(2) : 0;
        delete p.temps;
      }
    }

    successResponse(res, {
      shipmentNo,
      windowMinutes: 60,
      totalRecords: probeData.length,
      byLocation
    });
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

export default router;
