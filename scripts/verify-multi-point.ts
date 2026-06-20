import axios from 'axios';

const API_BASE = process.env.API_BASE || 'http://localhost:3000/api/v1';
const TEST_PREFIX = 'SP-TEST-';
const SHIPMENT_NOS = [`${TEST_PREFIX}A`, `${TEST_PREFIX}B`];

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTemp(t: number): string {
  return `${t > 0 ? '+' : ''}${t.toFixed(1)}°C`;
}

function buildTimeSeries(
  now: Date,
  count: number,
  startOffsetMin: number,
  probeId: string,
  location: string,
  tempFn: (i: number) => number
): any[] {
  const data: any[] = [];
  for (let i = 0; i < count; i++) {
    data.push({
      probeId,
      probeLocation: location,
      temperature: Math.round(tempFn(i) * 10) / 10,
      collectedAt: new Date(now.getTime() + (startOffsetMin + i) * 60 * 1000).toISOString()
    });
  }
  return data;
}

function printAlerts(alerts: any[]) {
  alerts.forEach((a: any) => {
    console.log(`   🚨 [${a.level}] ${a.ruleName} | 主触发:${a.probe}=${formatTemp(a.temperature)} | 触发${a.triggeredProbeCount}个探头`);
    a.triggeredProbes?.forEach((tp: any) => {
      console.log(`      - ${tp.probeId}: ${formatTemp(tp.temperature)}, 持续${Math.round(tp.durationSeconds / 60)}分钟`);
    });
    if (a.probesByLocation) {
      for (const [loc, probes] of Object.entries<any>(a.probesByLocation)) {
        const probeStr = probes.map((p: any) => `${p.probeId}:${formatTemp(p.temp)}(${p.stable ? '稳' : '异'})`).join(', ');
        console.log(`      ${loc}: [${probeStr}]`);
      }
    }
  });
}

async function cleanupTestData() {
  console.log(`🧹 清理 ${TEST_PREFIX}* 测试数据...`);
  const shipments = await prisma.shipment.findMany({
    where: { shipmentNo: { startsWith: TEST_PREFIX } },
    select: { id: true, shipmentNo: true }
  });
  if (shipments.length === 0) {
    console.log(`   无残留数据`);
    return;
  }
  const ids = shipments.map(s => s.id);
  for (const id of ids) {
    const notifs = await prisma.alertNotification.findMany({
      where: { alertRecord: { shipmentId: id } },
      select: { id: true }
    });
    if (notifs.length > 0) {
      await prisma.alertNotification.deleteMany({
        where: { id: { in: notifs.map((n: any) => n.id) } }
      });
    }
    await prisma.alertRecord.deleteMany({ where: { shipmentId: id } });
    await prisma.probeData.deleteMany({ where: { shipmentId: id } });
  }
  await prisma.shipment.deleteMany({ where: { id: { in: ids } } });
  console.log(`   已清理 ${ids.length} 个车次: ${shipments.map(s => s.shipmentNo).join(', ')}`);
}

async function ensureShipment(shipmentNo: string): Promise<number> {
  const existing = await prisma.shipment.findUnique({ where: { shipmentNo } });
  if (existing) return existing.id;
  const res = await axios.post(`${API_BASE}/shipments`, {
    shipmentNo,
    customerId: 1,
    vehicleId: 1,
    driverId: 3,
    temperatureZone: 'FROZEN',
    cargoDescription: '回归验证',
    targetTempMin: -25,
    targetTempMax: -18,
    status: 'IN_TRANSIT',
    startTime: new Date().toISOString()
  });
  return res.data.data.id;
}

async function step1_ingestReverse(shipmentNo: string, now: Date) {
  console.log(`\n--- 第一步: /ingest 倒序上报 [${shipmentNo}] ---`);
  console.log(`场景: 门边DA超温, 3个货心全部稳定`);
  console.log(`预期: ATTENTION 触发(门边关注)`);

  let data: any[] = [];
  data.push(...buildTimeSeries(now, 7, -7, 'DA', 'DOOR', i => -4.0 + i * 0.15));
  data.push(...buildTimeSeries(now, 7, -7, 'CA', 'CARGO_CORE', i => -20.0 + i * 0.15));
  data.push(...buildTimeSeries(now, 7, -7, 'CB', 'CARGO_CORE', i => -19.0 + i * 0.15));
  data.push(...buildTimeSeries(now, 7, -7, 'CC', 'CARGO_CORE', i => -20.5 + i * 0.15));
  data.push({ probeId: 'RA', probeLocation: 'RETURN_AIR', temperature: -13.0, collectedAt: new Date(now.getTime() - 1 * 60 * 1000).toISOString() });

  data.sort((a, b) => new Date(b.collectedAt).getTime() - new Date(a.collectedAt).getTime());

  const res = await axios.post(`${API_BASE}/probes/ingest`, { shipmentNo, data });
  console.log(`✅ 接收: ${res.data.data.received}条, 触发: ${res.data.data.alertsTriggered}个`);
  printAlerts(res.data.data.alerts);
  return res.data.data;
}

async function step2_ingestUpgrade(shipmentNo: string, now: Date) {
  console.log(`\n--- 第二步: /ingest 继续上报 [${shipmentNo}] ---`);
  console.log(`场景: 货心CB开始升温(> -15℃), 其他货心仍稳定`);
  console.log(`预期: 门边告警 ATTENTION → WARNING 升级`);

  let data: any[] = [];
  data.push(...buildTimeSeries(now, 5, 0, 'DA', 'DOOR', i => -3.0 + i * 0.2));
  data.push(...buildTimeSeries(now, 5, 0, 'CA', 'CARGO_CORE', () => -19.0));
  data.push(...buildTimeSeries(now, 5, 0, 'CB', 'CARGO_CORE', i => -14.0 + i * 0.5));
  data.push(...buildTimeSeries(now, 5, 0, 'CC', 'CARGO_CORE', () => -20.0));
  data.push({ probeId: 'RA', probeLocation: 'RETURN_AIR', temperature: -12.5, collectedAt: new Date(now.getTime() + 4 * 60 * 1000).toISOString() });

  const res = await axios.post(`${API_BASE}/probes/ingest`, { shipmentNo, data });
  console.log(`✅ 接收: ${res.data.data.received}条, 触发: ${res.data.data.alertsTriggered}个`);
  printAlerts(res.data.data.alerts);
  return res.data.data;
}

async function step3_batchMultiShipment(shipmentNos: string[], now2: Date) {
  console.log(`\n--- 第三步: /batch 正序上报 [${shipmentNos.join(', ')}] ---`);
  console.log(`场景: 货心CA/CB同时超温(> -10℃), 多车次混合上报`);
  console.log(`预期: A车触发CRITICAL(多货心) + WARNING(货心) + WARNING(门边升级)`);

  const records: any[] = [];
  for (const no of shipmentNos) {
    for (let i = 0; i < 7; i++) {
      records.push({ shipmentNo: no, probeId: 'CA', probeLocation: 'CARGO_CORE', temperature: Math.round((-8.5 + i * 0.3) * 10) / 10, collectedAt: new Date(now2.getTime() + (5 + i) * 60 * 1000).toISOString() });
    }
    for (let i = 0; i < 7; i++) {
      records.push({ shipmentNo: no, probeId: 'CB', probeLocation: 'CARGO_CORE', temperature: Math.round((-9.5 + i * 0.22) * 10) / 10, collectedAt: new Date(now2.getTime() + (5 + i) * 60 * 1000).toISOString() });
    }
    for (let i = 0; i < 3; i++) {
      records.push({ shipmentNo: no, probeId: 'CC', probeLocation: 'CARGO_CORE', temperature: -19.5, collectedAt: new Date(now2.getTime() + (5 + i) * 60 * 1000).toISOString() });
    }
    for (let i = 0; i < 3; i++) {
      records.push({ shipmentNo: no, probeId: 'DA', probeLocation: 'DOOR', temperature: Math.round((-2.0 + i * 0.3) * 10) / 10, collectedAt: new Date(now2.getTime() + (5 + i) * 60 * 1000).toISOString() });
    }
    records.push({ shipmentNo: no, probeId: 'RA', probeLocation: 'RETURN_AIR', temperature: -12.0, collectedAt: new Date(now2.getTime() + 7 * 60 * 1000).toISOString() });
  }

  records.sort((a, b) => new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime());

  const res = await axios.post(`${API_BASE}/probes/batch`, { records });
  const d = res.data.data;
  console.log(`✅ 总接收: ${d.received}条, 总触发: ${d.alertsTriggered}个`);
  console.log(`\n   � 按车次分组:`);
  for (const [no, summary] of Object.entries<any>(d.shipmentSummary || {})) {
    console.log(`   ${no}: 接收${summary.probesReceived}条, 触发${summary.alertsTriggered}个告警`);
    printAlerts(summary.alerts);
  }
  console.log(`\n   📋 顶层汇总告警:`);
  printAlerts(d.alerts);
  return d;
}

async function printReconciliation(shipmentNo: string) {
  console.log(`\n--- 对账视图: ${shipmentNo} ---`);
  const res = await axios.get(`${API_BASE}/alert-records/reconciliation`, { params: { shipmentNo } });
  const d = res.data.data;
  console.log(`总告警: ${d.totalAlerts} | 级别分布: ${JSON.stringify(d.levelBreakdown)}`);
  for (const a of d.alerts) {
    const stable = a.levelConsistent ? '✅' : '❌';
    console.log(`  #${a.alertId} [${a.finalLevel}] ${a.ruleName}`);
    console.log(`    触发探头: ${a.triggeredProbeCount}个 | 持续${a.durationMinutes}分钟`);
    if (a.triggeredProbes) {
      console.log(`    探头列表: ${a.triggeredProbes.map((p: any) => `${p.probeId}:${formatTemp(p.temperature)}`).join(', ')}`);
    }
    if (a.probesByLocation) {
      for (const [loc, probes] of Object.entries<any>(a.probesByLocation)) {
        const probeStr = probes.map((p: any) => `${p.probeId}:${formatTemp(p.temp)}(${p.stable ? '稳' : '异'})`).join(', ');
        console.log(`    ${loc}: [${probeStr}]`);
      }
    }
    console.log(`    通知${a.notificationCount}条 | 级别链: ${a.notificationLevelChain || '(无)'} | 最新: ${a.latestNotificationLevel || '(无)'} ${stable}`);
  }
}

async function runTest() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`🚀 多车次批量告警回归验证`);
  console.log(`📦 车次: ${SHIPMENT_NOS.join(', ')}`);
  console.log(`${'='.repeat(50)}`);

  await cleanupTestData();

  for (const no of SHIPMENT_NOS) {
    const id = await ensureShipment(no);
    console.log(`✅ 车次 ${no} 就绪 (ID:${id})`);
  }

  const now = new Date();

  await step1_ingestReverse(SHIPMENT_NOS[0], now);
  await sleep(500);

  await step2_ingestUpgrade(SHIPMENT_NOS[0], now);
  await sleep(500);

  await step1_ingestReverse(SHIPMENT_NOS[1], now);
  await sleep(500);

  await step2_ingestUpgrade(SHIPMENT_NOS[1], now);
  await sleep(500);

  const now2 = new Date();
  await step3_batchMultiShipment(SHIPMENT_NOS, now2);
  await sleep(800);

  for (const no of SHIPMENT_NOS) {
    await printReconciliation(no);
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`✅ 多车次批量告警回归验证完成`);
  console.log(`${'='.repeat(50)}\n`);
}

import prisma from '../src/config/prisma';

runTest()
  .catch(err => {
    console.error('❌ 验证失败:', err.message);
    if (err.response?.data) console.error('接口错误:', JSON.stringify(err.response.data, null, 2));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
