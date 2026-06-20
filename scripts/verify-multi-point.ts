import axios from 'axios';

const API_BASE = process.env.API_BASE || 'http://localhost:3000/api/v1';

interface TestResult {
  shipmentNo: string;
  shipmentId: number;
  ingest1: any;
  ingest2: any;
  batch: any;
  alertRecords: any[];
  notifications: any[];
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTemp(t: number): string {
  return `${t > 0 ? '+' : ''}${t.toFixed(1)}°C`;
}

function generateShipmentNo(): string {
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  return `SP-AUTO-${ts}`;
}

async function createShipment(shipmentNo: string): Promise<number> {
  const res = await axios.post(`${API_BASE}/shipments`, {
    shipmentNo,
    customerId: 1,
    vehicleId: 1,
    driverId: 3,
    temperatureZone: 'FROZEN',
    cargoDescription: '自动化多点验证',
    targetTempMin: -25,
    targetTempMax: -18,
    status: 'IN_TRANSIT',
    startTime: new Date().toISOString()
  });
  return res.data.data.id;
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

async function runTest(): Promise<TestResult> {
  const shipmentNo = generateShipmentNo();
  console.log(`\n========================================`);
  console.log(`🚀 开始自动化多点验证`);
  console.log(`📦 车次号: ${shipmentNo}`);
  console.log(`========================================`);

  const shipmentId = await createShipment(shipmentNo);
  console.log(`✅ 车次创建成功, ID: ${shipmentId}`);

  const now = new Date();

  // ============ 第一步: /ingest 倒序上报 - 门边超温,货心全部稳定 ============
  console.log(`\n--- 第一步: /ingest 倒序上报 ---`);
  console.log(`场景: 门边DA超温, 3个货心全部稳定`);
  console.log(`预期: 规则2 ATTENTION 触发(门边关注)`);

  let data1: any[] = [];

  // 门边DA: 7条, -3.0~-4.0℃ (> -5℃ 超温)
  data1.push(...buildTimeSeries(now, 7, -7, 'DA', 'DOOR', i => -4.0 + i * 0.15));

  // 货心CA: 7条, -19.0~-20.0℃ (≤ -15℃ 稳定)
  data1.push(...buildTimeSeries(now, 7, -7, 'CA', 'CARGO_CORE', i => -20.0 + i * 0.15));

  // 货心CB: 7条, -18.0~-19.0℃ (≤ -15℃ 稳定)
  data1.push(...buildTimeSeries(now, 7, -7, 'CB', 'CARGO_CORE', i => -19.0 + i * 0.15));

  // 货心CC: 7条, -19.5~-20.5℃ (≤ -15℃ 稳定)
  data1.push(...buildTimeSeries(now, 7, -7, 'CC', 'CARGO_CORE', i => -20.5 + i * 0.15));

  // 回风RA: 1条, -13.0℃ (稳定)
  data1.push({
    probeId: 'RA',
    probeLocation: 'RETURN_AIR',
    temperature: -13.0,
    collectedAt: new Date(now.getTime() - 1 * 60 * 1000).toISOString()
  });

  data1 = data1.sort((a, b) =>
    new Date(b.collectedAt).getTime() - new Date(a.collectedAt).getTime()
  );

  console.log(`发送 ${data1.length} 条数据(倒序): 门边7 + 货心21 + 回风1`);

  const ingest1 = await axios.post(`${API_BASE}/probes/ingest`, {
    shipmentNo,
    data: data1
  });

  console.log(`✅ 接收: ${ingest1.data.data.received}条, 触发告警: ${ingest1.data.data.alertsTriggered}个`);
  ingest1.data.data.alerts.forEach((a: any) => {
    console.log(`   🚨 [${a.level}] ${a.ruleName} | 主触发:${a.probe}=${formatTemp(a.temperature)} | 触发${a.triggeredProbeCount}个探头`);
    a.triggeredProbes?.forEach((tp: any) => {
      console.log(`      - ${tp.probeId}: ${formatTemp(tp.temperature)}, 持续${Math.round(tp.durationSeconds / 60)}分钟`);
    });
  });

  await sleep(500);

  // ============ 第二步: /ingest 继续上报 - 货心CB开始不稳定 ============
  console.log(`\n--- 第二步: /ingest 继续上报 ---`);
  console.log(`场景: 货心CB开始升温(> -15℃), 其他货心仍稳定`);
  console.log(`预期: 已有门边告警 ATTENTION → WARNING 升级, 重发通知`);

  let data2: any[] = [];

  // 门边DA: 5条新数据, 继续超温
  data2.push(...buildTimeSeries(now, 5, 0, 'DA', 'DOOR', i => -3.0 + i * 0.2));

  // 货心CA: 5条, 保持稳定 -19.0℃
  data2.push(...buildTimeSeries(now, 5, 0, 'CA', 'CARGO_CORE', () => -19.0));

  // 货心CB: 5条, 升温到 -12.0℃ (> -15℃ 不稳定)
  data2.push(...buildTimeSeries(now, 5, 0, 'CB', 'CARGO_CORE', i => -14.0 + i * 0.5));

  // 货心CC: 5条, 保持稳定 -20.0℃
  data2.push(...buildTimeSeries(now, 5, 0, 'CC', 'CARGO_CORE', () => -20.0));

  // 回风RA: 1条, -12.5℃
  data2.push({
    probeId: 'RA',
    probeLocation: 'RETURN_AIR',
    temperature: -12.5,
    collectedAt: new Date(now.getTime() + 4 * 60 * 1000).toISOString()
  });

  console.log(`发送 ${data2.length} 条数据: 门边5 + 货心15 + 回风1`);

  const ingest2 = await axios.post(`${API_BASE}/probes/ingest`, {
    shipmentNo,
    data: data2
  });

  console.log(`✅ 接收: ${ingest2.data.data.received}条, 触发告警: ${ingest2.data.data.alertsTriggered}个`);
  ingest2.data.data.alerts.forEach((a: any) => {
    console.log(`   🚨 [${a.level}] ${a.ruleName} | 主触发:${a.probe}=${formatTemp(a.temperature)} | 触发${a.triggeredProbeCount}个探头`);
  });

  await sleep(500);

  // ============ 第三步: /batch 正序上报 - 货心CA也开始超温 ============
  console.log(`\n--- 第三步: /batch 正序上报 ---`);
  console.log(`场景: 货心CA也超温(> -10℃), 多探头同时超温`);
  console.log(`预期: 规则4 CRITICAL 触发(多货心超温)`);

  const now2 = new Date();
  const records: any[] = [];

  // 货心CA: 7条新数据, -8.5~-6.8℃ (> -10℃ 严重超温)
  for (let i = 0; i < 7; i++) {
    records.push({
      shipmentNo,
      probeId: 'CA',
      probeLocation: 'CARGO_CORE',
      temperature: Math.round((-8.5 + i * 0.3) * 10) / 10,
      collectedAt: new Date(now2.getTime() + (5 + i) * 60 * 1000).toISOString()
    });
  }

  // 货心CB: 7条新数据, -9.5~-8.0℃ (> -10℃ 严重超温)
  for (let i = 0; i < 7; i++) {
    records.push({
      shipmentNo,
      probeId: 'CB',
      probeLocation: 'CARGO_CORE',
      temperature: Math.round((-9.5 + i * 0.22) * 10) / 10,
      collectedAt: new Date(now2.getTime() + (5 + i) * 60 * 1000).toISOString()
    });
  }

  // 货心CC: 3条新数据, 保持稳定 -19.5℃
  for (let i = 0; i < 3; i++) {
    records.push({
      shipmentNo,
      probeId: 'CC',
      probeLocation: 'CARGO_CORE',
      temperature: -19.5,
      collectedAt: new Date(now2.getTime() + (5 + i) * 60 * 1000).toISOString()
    });
  }

  // 门边DA: 3条新数据, 继续超温
  for (let i = 0; i < 3; i++) {
    records.push({
      shipmentNo,
      probeId: 'DA',
      probeLocation: 'DOOR',
      temperature: Math.round((-2.0 + i * 0.3) * 10) / 10,
      collectedAt: new Date(now2.getTime() + (5 + i) * 60 * 1000).toISOString()
    });
  }

  // 回风RA: 1条
  records.push({
    shipmentNo,
    probeId: 'RA',
    probeLocation: 'RETURN_AIR',
    temperature: -12.0,
    collectedAt: new Date(now2.getTime() + 7 * 60 * 1000).toISOString()
  });

  records.sort((a, b) =>
    new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime()
  );

  console.log(`发送 ${records.length} 条数据(正序): 货心CA5 + CB5 + CC3 + 门边3 + 回风1`);

  const batch = await axios.post(`${API_BASE}/probes/batch`, { records });

  console.log(`✅ 接收: ${batch.data.data.received}条, 触发告警: ${batch.data.data.alertsTriggered}个`);
  batch.data.data.alerts.forEach((a: any) => {
    console.log(`   🚨 [${a.level}] ${a.ruleName} | 主触发:${a.probe}=${formatTemp(a.temperature)} | 触发${a.triggeredProbeCount}个探头`);
    a.triggeredProbes?.forEach((tp: any) => {
      console.log(`      - ${tp.probeId}: ${formatTemp(tp.temperature)}, 持续${Math.round(tp.durationSeconds / 60)}分钟`);
    });
    if (a.probesByLocation) {
      console.log(`    各位置温度:`);
      for (const [loc, probes] of Object.entries<any>(a.probesByLocation)) {
        const probeStr = probes.map((p: any) => `${p.probeId}:${formatTemp(p.temp)}(${p.stable ? '稳定' : '异常'})`).join(', ');
        console.log(`      ${loc}: [${probeStr}]`);
      }
    }
  });

  await sleep(800);

  // ============ 查询告警记录 ============
  console.log(`\n--- 最终对账: 告警记录 ---`);
  const alertsRes = await axios.get(`${API_BASE}/alert-records`, {
    params: { shipmentNo, pageSize: 10 }
  });
  const alertRecords = alertsRes.data.data;

  console.log(`共 ${alertRecords.length} 条告警记录:`);
  alertRecords.forEach((r: any) => {
    console.log(`\n  #${r.id} [${r.alertLevel}] ${r.rule.name}`);
    console.log(`    状态: ${r.status} | 持续${r.durationMinutes}分钟 | 主触发${r.probeId}=${formatTemp(r.triggerTemp)}`);
    console.log(`    触发探头数: ${r.triggeredProbeCount}`);
    r.triggeredProbes?.forEach((tp: any) => {
      console.log(`      - ${tp.probeId}: ${formatTemp(tp.temperature)}`);
    });
    if (r.probesByLocation) {
      console.log(`    各位置最新温度:`);
      for (const loc of Object.keys(r.probesByLocation)) {
        const probes = r.probesByLocation[loc];
        const probeStr = probes.map((p: any) =>
          `${p.probeId}:${formatTemp(p.temp)}(${p.stable ? '稳定' : '异常'})`
        ).join(', ');
        console.log(`      ${loc}: [${probeStr}]`);
      }
    }
    console.log(`    通知数: ${r.notificationCount}`);
  });

  // ============ 查询通知记录 ============
  console.log(`\n--- 最终对账: 通知记录(最新4条) ---`);
  const notifRes = await axios.get(`${API_BASE}/notifications`, {
    params: { pageSize: 20, sort: '-createdAt' }
  });
  const allNotifs = notifRes.data.data;
  const alertIds = alertRecords.map((a: any) => a.id);
  const notifications = allNotifs.filter((n: any) => alertIds.includes(n.alertRecordId));

  const latestByAlert = new Map<number, any[]>();
  notifications.forEach((n: any) => {
    const list = latestByAlert.get(n.alertRecordId) || [];
    list.push(n);
    latestByAlert.set(n.alertRecordId, list);
  });

  for (const [alertId, list] of latestByAlert) {
    const alert = alertRecords.find((a: any) => a.id === alertId);
    console.log(`\n  告警#${alertId} [${alert?.alertLevel}] 通知 ${list.length} 条:`);
    const sortedByTime = [...list].sort((a, b) =>
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
    const levelChanges: string[] = [];
    for (const n of sortedByTime) {
      const levelMatch = n.content.match(/【[^】]+-(.+?)】/);
      if (levelMatch) levelChanges.push(levelMatch[1]);
    }
    const uniqueLevels = [...new Set(levelChanges)];
    console.log(`    通知级别变化: ${uniqueLevels.join(' → ')}`);
    list.slice(-2).forEach((n: any) => {
      console.log(`    - ${n.user.realName}(${n.user.role}) [${n.channel}]: ${n.content.substring(0, 60)}...`);
    });
  }

  // ============ 对账汇总 ============
  console.log(`\n========================================`);
  console.log(`📊 对账汇总表`);
  console.log(`========================================`);
  console.log(`车次: ${shipmentNo} (ID:${shipmentId})`);
  console.log(`接口返回告警数: 步骤1=${ingest1.data.data.alertsTriggered}, 步骤2=${ingest2.data.data.alertsTriggered}, 步骤3=${batch.data.data.alertsTriggered}`);
  console.log(`数据库告警数: ${alertRecords.length}`);
  console.log(`通知总数: ${notifications.length}`);

  const criticalAlert = alertRecords.find((a: any) => a.alertLevel === 'CRITICAL');
  if (criticalAlert) {
    console.log(`\n✅ CRITICAL 告警对账:`);
    console.log(`   触发探头数: 期望≥2, 实际=${criticalAlert.triggeredProbeCount}`);
    console.log(`   探头列表: ${criticalAlert.triggeredProbes?.map((p: any) => p.probeId).join(', ')}`);
    console.log(`   级别一致性: 列表=${criticalAlert.alertLevel}, 详情=${criticalAlert.alertLevel}`);
  }

  const doorAlert = alertRecords.find((a: any) => a.rule.id === 2);
  if (doorAlert) {
    console.log(`\n✅ 门边告警对账:`);
    console.log(`   最终级别: 期望=WARNING(升级后), 实际=${doorAlert.alertLevel}`);
    console.log(`   货心探头: ${doorAlert.probesByLocation?.CARGO_CORE?.map((p: any) => `${p.probeId}:${formatTemp(p.temp)}(${p.stable ? '稳' : '异'})`).join(', ')}`);
  }

  console.log(`\n========================================`);
  console.log(`✅ 自动化多点验证完成`);
  console.log(`========================================\n`);

  return {
    shipmentNo,
    shipmentId,
    ingest1: ingest1.data.data,
    ingest2: ingest2.data.data,
    batch: batch.data.data,
    alertRecords,
    notifications
  };
}

runTest().catch(err => {
  console.error('❌ 验证失败:', err.message);
  if (err.response?.data) {
    console.error('接口错误:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
