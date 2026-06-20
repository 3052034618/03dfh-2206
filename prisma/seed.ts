import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const UserRole = {
  DRIVER: 'DRIVER',
  DISPATCHER: 'DISPATCHER',
  QC_CUSTOMER: 'QC_CUSTOMER',
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERATOR'
};

const ProbeLocation = {
  CARGO_CORE: 'CARGO_CORE',
  DOOR: 'DOOR',
  RETURN_AIR: 'RETURN_AIR',
  EVAPORATOR: 'EVAPORATOR',
  AMBIENT: 'AMBIENT',
  CUSTOM: 'CUSTOM'
};

const TemperatureZone = {
  FROZEN: 'FROZEN',
  CHILLED: 'CHILLED',
  CONSTANT_TEMP: 'CONSTANT_TEMP',
  AMBIENT: 'AMBIENT',
  DUAL_TEMP: 'DUAL_TEMP'
};

const AlertLevel = {
  ATTENTION: 'ATTENTION',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
  FATAL: 'FATAL'
};

async function main() {
  console.log('开始初始化种子数据...');

  const customer1 = await prisma.customer.upsert({
    where: { code: 'CUST001' },
    update: {},
    create: {
      name: '顺丰冷链物流',
      code: 'CUST001',
      contactPerson: '张经理',
      contactPhone: '13800138001',
      wechatGroup: '顺丰冷链质控群'
    }
  });

  const customer2 = await prisma.customer.upsert({
    where: { code: 'CUST002' },
    update: {},
    create: {
      name: '京东冷链配送',
      code: 'CUST002',
      contactPerson: '李主管',
      contactPhone: '13800138002',
      wechatGroup: '京东质控工作群'
    }
  });

  const vehicle1 = await prisma.vehicle.upsert({
    where: { plateNumber: '京A·88888' },
    update: {},
    create: {
      plateNumber: '京A·88888',
      vehicleType: '冷藏车-9.6米',
      gpsDeviceId: 'GPS-001'
    }
  });

  const vehicle2 = await prisma.vehicle.upsert({
    where: { plateNumber: '沪B·66666' },
    update: {},
    create: {
      plateNumber: '沪B·66666',
      vehicleType: '冷藏车-6.8米',
      gpsDeviceId: 'GPS-002'
    }
  });

  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: {
      username: 'admin',
      password: 'admin123',
      realName: '系统管理员',
      role: UserRole.ADMIN,
      phone: '13900139000'
    }
  });

  await prisma.user.upsert({
    where: { username: 'operator01' },
    update: {},
    create: {
      username: 'operator01',
      password: '123456',
      realName: '运营小王',
      role: UserRole.OPERATOR,
      phone: '13900139001'
    }
  });

  const driver = await prisma.user.upsert({
    where: { username: 'driver01' },
    update: {},
    create: {
      username: 'driver01',
      password: '123456',
      realName: '王师傅',
      role: UserRole.DRIVER,
      phone: '13700137001'
    }
  });

  await prisma.user.upsert({
    where: { username: 'dispatch01' },
    update: {},
    create: {
      username: 'dispatch01',
      password: '123456',
      realName: '调度张',
      role: UserRole.DISPATCHER,
      phone: '13600136001'
    }
  });

  await prisma.user.upsert({
    where: { username: 'qc001' },
    update: {},
    create: {
      username: 'qc001',
      password: '123456',
      realName: '顺丰质控-刘',
      role: UserRole.QC_CUSTOMER,
      phone: '13500135001',
      customerId: customer1.id
    }
  });

  const shipment1 = await prisma.shipment.upsert({
    where: { shipmentNo: 'SP202606210001' },
    update: {},
    create: {
      shipmentNo: 'SP202606210001',
      customerId: customer1.id,
      vehicleId: vehicle1.id,
      driverId: driver.id,
      temperatureZone: TemperatureZone.FROZEN,
      cargoDescription: '冷冻肉制品-20吨',
      targetTempMin: -25,
      targetTempMax: -18,
      startTime: new Date('2026-06-21T08:00:00'),
      status: 'IN_TRANSIT'
    }
  });

  const shipment2 = await prisma.shipment.upsert({
    where: { shipmentNo: 'SP202606210002' },
    update: {},
    create: {
      shipmentNo: 'SP202606210002',
      customerId: customer2.id,
      vehicleId: vehicle2.id,
      temperatureZone: TemperatureZone.CHILLED,
      cargoDescription: '生鲜蔬菜-8吨',
      targetTempMin: 2,
      targetTempMax: 8,
      startTime: new Date('2026-06-21T06:00:00'),
      status: 'IN_TRANSIT'
    }
  });

  await prisma.alertRule.deleteMany({});

  await prisma.alertRule.createMany({
    data: [
      {
        name: '冷冻品-货心温度过高',
        description: '冷冻品任一货心探头高于-15℃持续10分钟触发报警',
        customerId: customer1.id,
        temperatureZone: TemperatureZone.FROZEN,
        probeLocation: ProbeLocation.CARGO_CORE,
        conditionType: 'TEMPERATURE_ABOVE',
        operator: '>',
        thresholdTemp: -15,
        durationMinutes: 10,
        alertLevel: AlertLevel.WARNING,
        notifyRoles: JSON.stringify(['DRIVER', 'DISPATCHER', 'QC_CUSTOMER']),
        priority: 10
      },
      {
        name: '冷冻品-门边突升但货心稳定',
        description: '门边探头温度突升，但货心探头稳定在阈值内，只提示关注',
        customerId: customer1.id,
        temperatureZone: TemperatureZone.FROZEN,
        probeLocation: ProbeLocation.DOOR,
        conditionType: 'TEMPERATURE_SPIKE_WITH_COMPARE',
        operator: '>',
        thresholdTemp: -5,
        compareProbeLocation: ProbeLocation.CARGO_CORE,
        compareThreshold: -15,
        durationMinutes: 5,
        alertLevel: AlertLevel.ATTENTION,
        notifyRoles: JSON.stringify(['DISPATCHER']),
        priority: 5
      },
      {
        name: '冷藏品-货心温度超限',
        description: '冷藏品货心温度高于8℃持续15分钟报警',
        customerId: customer2.id,
        temperatureZone: TemperatureZone.CHILLED,
        probeLocation: ProbeLocation.CARGO_CORE,
        conditionType: 'TEMPERATURE_ABOVE',
        operator: '>',
        thresholdTemp: 8,
        durationMinutes: 15,
        alertLevel: AlertLevel.WARNING,
        notifyRoles: JSON.stringify(['DRIVER', 'DISPATCHER', 'QC_CUSTOMER']),
        priority: 10
      },
      {
        name: '冷冻品-严重超温',
        description: '冷冻品货心高于-10℃持续5分钟，严重报警',
        temperatureZone: TemperatureZone.FROZEN,
        probeLocation: ProbeLocation.CARGO_CORE,
        conditionType: 'TEMPERATURE_ABOVE',
        operator: '>',
        thresholdTemp: -10,
        durationMinutes: 5,
        alertLevel: AlertLevel.CRITICAL,
        notifyRoles: JSON.stringify(['DRIVER', 'DISPATCHER', 'QC_CUSTOMER', 'OPERATOR']),
        priority: 20
      },
      {
        name: '通用-回风温度异常',
        description: '回风探头与货心温差超过8℃，提醒检查制冷机组',
        probeLocation: ProbeLocation.RETURN_AIR,
        conditionType: 'DIFF_WITH_COMPARE',
        operator: '>',
        thresholdTemp: 8,
        compareProbeLocation: ProbeLocation.CARGO_CORE,
        durationMinutes: 10,
        alertLevel: AlertLevel.WARNING,
        notifyRoles: JSON.stringify(['DRIVER', 'DISPATCHER']),
        priority: 8
      }
    ]
  });

  console.log('种子数据初始化完成！');
  console.log(`客户: ${customer1.name}, ${customer2.name}`);
  console.log(`车辆: ${vehicle1.plateNumber}, ${vehicle2.plateNumber}`);
  console.log(`用户: admin, operator01, driver01, dispatch01, qc001`);
  console.log(`车次: ${shipment1.shipmentNo}, ${shipment2.shipmentNo}`);
  console.log('告警规则: 已创建 5 条示例规则');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
