import {
  AlertRule,
  ProbeData,
  Shipment,
  Customer
} from '@prisma/client';
import { AlertStatus } from '../types/enums';
import prisma from '../config/prisma';
import logger from '../utils/logger';
import { NotificationService } from './notification.service';

export interface ProbeSnapshot {
  probeId: string;
  probeLocation: string;
  temperature: number;
  collectedAt: Date;
}

export interface RuleMatchContext {
  shipment: Shipment & { customer: Customer; vehicle: any };
  allProbes: ProbeData[];
  latestByLocation: Map<string, ProbeSnapshot[]>;
  triggeredAt: Date;
}

export interface TriggeredProbeInfo {
  probeId: string;
  probeLocation: string;
  temperature: number;
  durationSeconds: number;
  firstTriggeredAt: Date;
}

export interface AlertResult {
  triggered: boolean;
  alertLevel?: string;
  triggerProbe?: ProbeSnapshot;
  triggeredProbes?: TriggeredProbeInfo[];
  durationSeconds?: number;
  firstTriggeredAt?: Date;
  probeComparison?: Record<string, any>;
  matchedRule?: AlertRule;
}

export interface ProbeComparison {
  triggerProbe: {
    probeId: string;
    location: string;
    temp: number;
  };
  triggeredProbes?: TriggeredProbeInfo[];
  triggeredProbeCount?: number;
  adjacentProbes: Array<{
    probeId: string;
    location: string;
    temp: number;
    diff: number;
  }>;
  probesByLocation: Record<string, Array<{
    probeId: string;
    temp: number;
    stable: boolean;
  }>>;
  locationSummary: Record<string, {
    count: number;
    avgTemp: number;
    minTemp: number;
    maxTemp: number;
  }>;
  note?: string;
}

export class AlertEngineService {
  private notificationService: NotificationService;

  constructor() {
    this.notificationService = new NotificationService();
  }

  async processProbeData(probeDataList: ProbeData[]): Promise<AlertResult[]> {
    if (probeDataList.length === 0) return [];

    const shipmentIds = [...new Set(probeDataList.map(p => p.shipmentId))];
    const allResults: AlertResult[] = [];

    for (const shipmentId of shipmentIds) {
      const shipmentProbes = probeDataList.filter(p => p.shipmentId === shipmentId);
      try {
        const results = await this.processShipmentProbes(shipmentId, shipmentProbes);
        allResults.push(...results);
      } catch (error: any) {
        logger.error(`处理车次 ${shipmentId} 探头数据失败:`, error);
      }
    }

    return allResults;
  }

  private async processShipmentProbes(
    shipmentId: number,
    _newProbes: ProbeData[]
  ): Promise<AlertResult[]> {
    const shipment = await prisma.shipment.findUnique({
      where: { id: shipmentId },
      include: {
        customer: true,
        vehicle: true
      }
    });

    if (!shipment) {
      logger.warn(`车次 ${shipmentId} 不存在，跳过告警判断`);
      return [];
    }

    if (shipment.status !== 'IN_TRANSIT') {
      logger.debug(`车次 ${shipment.shipmentNo} 状态为 ${shipment.status}，跳过告警判断`);
      return [];
    }

    const maxDuration = 60;
    const windowStart = new Date(Date.now() - maxDuration * 60 * 1000);

    const allProbes = await prisma.probeData.findMany({
      where: {
        shipmentId,
        collectedAt: { gte: windowStart }
      },
      orderBy: { collectedAt: 'desc' }
    });

    const latestByLocation = new Map<string, ProbeSnapshot[]>();
    for (const probe of allProbes) {
      const list = latestByLocation.get(probe.probeLocation) || [];
      list.push({
        probeId: probe.probeId,
        probeLocation: probe.probeLocation,
        temperature: probe.temperature,
        collectedAt: probe.collectedAt
      });
      latestByLocation.set(probe.probeLocation, list);
    }

    for (const [location, list] of latestByLocation) {
      list.sort((a, b) =>
        new Date(b.collectedAt).getTime() - new Date(a.collectedAt).getTime()
      );
      latestByLocation.set(location, list);
    }

    const rules = await prisma.alertRule.findMany({
      where: {
        isActive: true,
        OR: [
          { customerId: null },
          { customerId: shipment.customerId }
        ]
      },
      orderBy: { priority: 'desc' }
    });

    const applicableRules = rules.filter(rule => {
      if (rule.temperatureZone && rule.temperatureZone !== shipment.temperatureZone) {
        return false;
      }
      if (rule.vehicleType && rule.vehicleType !== shipment.vehicle?.vehicleType) {
        return false;
      }
      return true;
    });

    if (applicableRules.length === 0) {
      logger.debug(`车次 ${shipment.shipmentNo} 没有匹配的告警规则`);
      return [];
    }

    const context: RuleMatchContext = {
      shipment: shipment as any,
      allProbes,
      latestByLocation,
      triggeredAt: new Date()
    };

    const results: AlertResult[] = [];
    const triggeredRuleIds = new Set<number>();

    for (const rule of applicableRules) {
      if (triggeredRuleIds.has(rule.id)) continue;

      const result = this.evaluateRule(rule, context);
      if (result.triggered && result.matchedRule) {
        triggeredRuleIds.add(result.matchedRule.id);
        results.push(result);

        await this.handleAlertTrigger(rule, context, result);
      }
    }

    await this.resolveAutoRecoveredAlerts(shipmentId, applicableRules, context);

    return results;
  }

  private evaluateRule(rule: AlertRule, ctx: RuleMatchContext): AlertResult {
    const probes = ctx.latestByLocation.get(rule.probeLocation) || [];
    if (probes.length === 0) {
      return { triggered: false };
    }

    switch (rule.conditionType) {
      case 'TEMPERATURE_ABOVE':
        return this.evaluateTemperatureAbove(rule, probes, ctx);

      case 'TEMPERATURE_BELOW':
        return this.evaluateTemperatureBelow(rule, probes, ctx);

      case 'TEMPERATURE_SPIKE_WITH_COMPARE':
        return this.evaluateSpikeWithCompare(rule, probes, ctx);

      case 'DIFF_WITH_COMPARE':
        return this.evaluateDiffWithCompare(rule, probes, ctx);

      case 'ANY_ABOVE':
        return this.evaluateAnyAbove(rule, probes, ctx);

      default:
        logger.warn(`未知的条件类型: ${rule.conditionType}`);
        return { triggered: false };
    }
  }

  private collectTriggeredProbes(
    probeGroups: Map<string, ProbeSnapshot[]>,
    rule: AlertRule,
    condition: (temp: number) => boolean,
    ctx: RuleMatchContext
  ): TriggeredProbeInfo[] {
    const triggered: TriggeredProbeInfo[] = [];

    for (const [probeId, probeList] of probeGroups) {
      const sorted = [...probeList].sort((a, b) =>
        new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime()
      );

      const { sustained, startAt, latest } = this.findSustainedCondition(
        sorted,
        condition,
        rule.durationMinutes
      );

      if (sustained && startAt && latest) {
        const duration = Math.floor(
          (ctx.triggeredAt.getTime() - new Date(startAt).getTime()) / 1000
        );
        triggered.push({
          probeId,
          probeLocation: latest.probeLocation,
          temperature: latest.temperature,
          durationSeconds: duration,
          firstTriggeredAt: new Date(startAt)
        });
      }
    }

    return triggered;
  }

  private evaluateTemperatureAbove(
    rule: AlertRule,
    probes: ProbeSnapshot[],
    ctx: RuleMatchContext
  ): AlertResult {
    const probeGroups = this.groupByProbeId(probes);
    const triggeredList = this.collectTriggeredProbes(
      probeGroups, rule, (temp) => temp > rule.thresholdTemp, ctx
    );

    if (triggeredList.length === 0) return { triggered: false };

    const worst = triggeredList.reduce((a, b) => a.temperature > b.temperature ? a : b);
    const earliestStart = triggeredList.reduce((a, b) => a.firstTriggeredAt < b.firstTriggeredAt ? a : b);

    const comparison = this.buildProbeComparison(
      { probeId: worst.probeId, probeLocation: worst.probeLocation, temperature: worst.temperature, collectedAt: ctx.triggeredAt },
      ctx,
      rule
    );

    return {
      triggered: true,
      alertLevel: rule.alertLevel,
      triggerProbe: { probeId: worst.probeId, probeLocation: worst.probeLocation, temperature: worst.temperature, collectedAt: ctx.triggeredAt },
      triggeredProbes: triggeredList,
      durationSeconds: Math.floor(
        (ctx.triggeredAt.getTime() - earliestStart.firstTriggeredAt.getTime()) / 1000
      ),
      firstTriggeredAt: earliestStart.firstTriggeredAt,
      probeComparison: comparison as any,
      matchedRule: rule
    };
  }

  private evaluateTemperatureBelow(
    rule: AlertRule,
    probes: ProbeSnapshot[],
    ctx: RuleMatchContext
  ): AlertResult {
    const probeGroups = this.groupByProbeId(probes);
    const triggeredList = this.collectTriggeredProbes(
      probeGroups, rule, (temp) => temp < rule.thresholdTemp, ctx
    );

    if (triggeredList.length === 0) return { triggered: false };

    const worst = triggeredList.reduce((a, b) => a.temperature < b.temperature ? a : b);
    const earliestStart = triggeredList.reduce((a, b) => a.firstTriggeredAt < b.firstTriggeredAt ? a : b);

    const comparison = this.buildProbeComparison(
      { probeId: worst.probeId, probeLocation: worst.probeLocation, temperature: worst.temperature, collectedAt: ctx.triggeredAt },
      ctx,
      rule
    );

    return {
      triggered: true,
      alertLevel: rule.alertLevel,
      triggerProbe: { probeId: worst.probeId, probeLocation: worst.probeLocation, temperature: worst.temperature, collectedAt: ctx.triggeredAt },
      triggeredProbes: triggeredList,
      durationSeconds: Math.floor(
        (ctx.triggeredAt.getTime() - earliestStart.firstTriggeredAt.getTime()) / 1000
      ),
      firstTriggeredAt: earliestStart.firstTriggeredAt,
      probeComparison: comparison as any,
      matchedRule: rule
    };
  }

  private evaluateSpikeWithCompare(
    rule: AlertRule,
    probes: ProbeSnapshot[],
    ctx: RuleMatchContext
  ): AlertResult {
    if (!rule.compareProbeLocation || rule.compareThreshold == null) {
      return { triggered: false };
    }

    const compareProbes = ctx.latestByLocation.get(rule.compareProbeLocation) || [];
    if (compareProbes.length === 0) {
      return { triggered: false };
    }

    const compareGroups = this.groupByProbeId(compareProbes);
    const compareLatestByProbe: Array<{ probeId: string; temp: number }> = [];
    let allCompareOk = true;
    const unstableProbes: string[] = [];

    for (const [probeId, probeList] of compareGroups) {
      const sorted = [...probeList].sort((a, b) =>
        new Date(b.collectedAt).getTime() - new Date(a.collectedAt).getTime()
      );
      const latest = sorted[0];
      compareLatestByProbe.push({ probeId, temp: latest.temperature });

      if (latest.temperature > rule.compareThreshold) {
        allCompareOk = false;
        unstableProbes.push(probeId);
      }
    }

    const probeGroups = this.groupByProbeId(probes);
    const triggeredList = this.collectTriggeredProbes(
      probeGroups, rule, (temp) => temp > rule.thresholdTemp, ctx
    );

    if (triggeredList.length === 0) return { triggered: false };

    const worst = triggeredList.reduce((a, b) => a.temperature > b.temperature ? a : b);
    const earliestStart = triggeredList.reduce((a, b) => a.firstTriggeredAt < b.firstTriggeredAt ? a : b);

    const comparison = this.buildProbeComparison(
      { probeId: worst.probeId, probeLocation: worst.probeLocation, temperature: worst.temperature, collectedAt: ctx.triggeredAt },
      ctx,
      rule
    );

    if (!allCompareOk) {
      (comparison as any).note = `${rule.compareProbeLocation}探头${unstableProbes.join(',')}已不稳定(${compareLatestByProbe.filter(p => unstableProbes.includes(p.probeId)).map(p => `${p.probeId}:${p.temp}°C`).join(', ')}),不再仅按${rule.probeLocation}关注处理`;
      return {
        triggered: true,
        alertLevel: 'WARNING',
        triggerProbe: { probeId: worst.probeId, probeLocation: worst.probeLocation, temperature: worst.temperature, collectedAt: ctx.triggeredAt },
        triggeredProbes: triggeredList,
        durationSeconds: Math.floor(
          (ctx.triggeredAt.getTime() - earliestStart.firstTriggeredAt.getTime()) / 1000
        ),
        firstTriggeredAt: earliestStart.firstTriggeredAt,
        probeComparison: comparison as any,
        matchedRule: rule
      };
    }

    const stableInfo = compareLatestByProbe.map(p => `${p.probeId}:${p.temp}°C`).join(', ');
    (comparison as any).note = `${rule.compareProbeLocation}探头全部稳定(${stableInfo}),仅${rule.probeLocation}异常`;

    return {
      triggered: true,
      alertLevel: rule.alertLevel,
      triggerProbe: { probeId: worst.probeId, probeLocation: worst.probeLocation, temperature: worst.temperature, collectedAt: ctx.triggeredAt },
      triggeredProbes: triggeredList,
      durationSeconds: Math.floor(
        (ctx.triggeredAt.getTime() - earliestStart.firstTriggeredAt.getTime()) / 1000
      ),
      firstTriggeredAt: earliestStart.firstTriggeredAt,
      probeComparison: comparison as any,
      matchedRule: rule
    };
  }

  private evaluateDiffWithCompare(
    rule: AlertRule,
    probes: ProbeSnapshot[],
    ctx: RuleMatchContext
  ): AlertResult {
    if (!rule.compareProbeLocation) {
      return { triggered: false };
    }

    const compareProbes = ctx.latestByLocation.get(rule.compareProbeLocation) || [];
    if (compareProbes.length === 0) {
      return { triggered: false };
    }

    const probeGroups = this.groupByProbeId(probes);
    const compareGroups = this.groupByProbeId(compareProbes);
    let bestMatch: AlertResult = { triggered: false };

    for (const [probeId, probeList] of probeGroups) {
      const sorted = [...probeList].sort((a, b) =>
        new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime()
      );

      const pairedCompare: ProbeSnapshot[] = [];
      for (const p of sorted) {
        const ts = new Date(p.collectedAt).getTime();
        let closest: ProbeSnapshot | null = null;
        let minDiff = Infinity;

        for (const [, clist] of compareGroups) {
          for (const cp of clist) {
            const diff = Math.abs(new Date(cp.collectedAt).getTime() - ts);
            if (diff < minDiff && diff < 5 * 60 * 1000) {
              minDiff = diff;
              closest = cp;
            }
          }
        }
        if (closest) pairedCompare.push(closest);
      }

      if (pairedCompare.length < sorted.length * 0.5) continue;

      const diffPairs = sorted
        .map((p, i) => ({
          probe: p,
          diff: pairedCompare[i] ? Math.abs(p.temperature - pairedCompare[i].temperature) : 0,
          compareTemp: pairedCompare[i]?.temperature
        }))
        .filter(d => d.compareTemp != null);

      const sustainedPairs: typeof diffPairs = [];
      let startIdx = -1;

      for (let i = 0; i < diffPairs.length; i++) {
        if (diffPairs[i].diff > rule.thresholdTemp) {
          if (startIdx === -1) startIdx = i;
          sustainedPairs.push(diffPairs[i]);
        } else {
          startIdx = -1;
          sustainedPairs.length = 0;
        }
      }

      if (sustainedPairs.length > 0 && startIdx !== -1) {
        const firstTime = new Date(diffPairs[startIdx].probe.collectedAt);
        const lastTime = new Date(sustainedPairs[sustainedPairs.length - 1].probe.collectedAt);
        const duration = Math.floor((lastTime.getTime() - firstTime.getTime()) / 1000);

        if (duration >= rule.durationMinutes * 60) {
          const latest = sustainedPairs[sustainedPairs.length - 1].probe;
          const comparison = this.buildProbeComparison(latest, ctx, rule);

          const result: AlertResult = {
            triggered: true,
            alertLevel: rule.alertLevel,
            triggerProbe: latest,
            triggeredProbes: [{
              probeId: latest.probeId,
              probeLocation: latest.probeLocation,
              temperature: latest.temperature,
              durationSeconds: duration,
              firstTriggeredAt: firstTime
            }],
            durationSeconds: duration,
            firstTriggeredAt: firstTime,
            probeComparison: comparison as any,
            matchedRule: rule
          };

          if (!bestMatch.triggered || duration > (bestMatch.durationSeconds || 0)) {
            bestMatch = result;
          }
        }
      }
    }

    return bestMatch;
  }

  private evaluateAnyAbove(
    rule: AlertRule,
    probes: ProbeSnapshot[],
    ctx: RuleMatchContext
  ): AlertResult {
    const latestByProbe = new Map<string, ProbeSnapshot>();
    for (const p of probes) {
      const existing = latestByProbe.get(p.probeId);
      if (!existing || new Date(p.collectedAt) > new Date(existing.collectedAt)) {
        latestByProbe.set(p.probeId, p);
      }
    }

    const violating: ProbeSnapshot[] = [];
    for (const [, probe] of latestByProbe) {
      if (probe.temperature > rule.thresholdTemp) {
        violating.push(probe);
      }
    }

    if (violating.length === 0) return { triggered: false };

    if (rule.durationMinutes > 0) {
      const probeGroups = this.groupByProbeId(probes);
      const sustainedViolating: ProbeSnapshot[] = [];
      let earliestStart: Date | null = null;

      for (const v of violating) {
        const group = probeGroups.get(v.probeId) || [];
        const sorted = [...group].sort((a, b) =>
          new Date(a.collectedAt).getTime() - new Date(b.collectedAt).getTime()
        );
        const { sustained, startAt } = this.findSustainedCondition(
          sorted,
          (temp) => temp > rule.thresholdTemp,
          rule.durationMinutes
        );
        if (sustained) {
          sustainedViolating.push(v);
          if (!earliestStart || startAt! < earliestStart) {
            earliestStart = startAt!;
          }
        }
      }

      if (sustainedViolating.length === 0 || !earliestStart) {
        return { triggered: false };
      }

      const worst = sustainedViolating.reduce((a, b) => a.temperature > b.temperature ? a : b);
      const duration = Math.floor(
        (ctx.triggeredAt.getTime() - earliestStart.getTime()) / 1000
      );

      const comparison = this.buildProbeComparison(worst, ctx, rule);
      (comparison as any).violatingCount = sustainedViolating.length;
      (comparison as any).violatingProbes = sustainedViolating.map(v => ({
        probeId: v.probeId,
        temp: v.temperature
      }));

      return {
        triggered: true,
        alertLevel: rule.alertLevel,
        triggerProbe: worst,
        triggeredProbes: sustainedViolating.map(v => ({
          probeId: v.probeId,
          probeLocation: v.probeLocation,
          temperature: v.temperature,
          durationSeconds: duration,
          firstTriggeredAt: earliestStart!
        })),
        durationSeconds: duration,
        firstTriggeredAt: earliestStart,
        probeComparison: comparison as any,
        matchedRule: rule
      };
    }

    const worst = violating.reduce((a, b) => a.temperature > b.temperature ? a : b);
    const comparison = this.buildProbeComparison(worst, ctx, rule);
    (comparison as any).violatingCount = violating.length;

    return {
      triggered: true,
      alertLevel: rule.alertLevel,
      triggerProbe: worst,
      triggeredProbes: violating.map(v => ({
        probeId: v.probeId,
        probeLocation: v.probeLocation,
        temperature: v.temperature,
        durationSeconds: 0,
        firstTriggeredAt: ctx.triggeredAt
      })),
      durationSeconds: 0,
      firstTriggeredAt: ctx.triggeredAt,
      probeComparison: comparison as any,
      matchedRule: rule
    };
  }

  private groupByProbeId(snapshots: ProbeSnapshot[]): Map<string, ProbeSnapshot[]> {
    const groups = new Map<string, ProbeSnapshot[]>();
    for (const s of snapshots) {
      const list = groups.get(s.probeId) || [];
      list.push(s);
      groups.set(s.probeId, list);
    }
    return groups;
  }

  private getLatestByProbe(snapshots: ProbeSnapshot[]): Map<string, ProbeSnapshot> {
    const latest = new Map<string, ProbeSnapshot>();
    for (const s of snapshots) {
      const existing = latest.get(s.probeId);
      if (!existing || new Date(s.collectedAt) > new Date(existing.collectedAt)) {
        latest.set(s.probeId, s);
      }
    }
    return latest;
  }

  private findSustainedCondition(
    sortedProbes: ProbeSnapshot[],
    condition: (temp: number) => boolean,
    durationMinutes: number
  ): { sustained: boolean; startAt: Date | null; latest: ProbeSnapshot | null } {
    if (sortedProbes.length === 0) {
      return { sustained: false, startAt: null, latest: null };
    }

    if (durationMinutes === 0) {
      const latest = sortedProbes[sortedProbes.length - 1];
      if (condition(latest.temperature)) {
        return { sustained: true, startAt: latest.collectedAt, latest };
      }
      return { sustained: false, startAt: null, latest: null };
    }

    let maxRunStartIdx = -1;
    let maxRunEndIdx = -1;
    let currentRunStartIdx = -1;

    for (let i = 0; i < sortedProbes.length; i++) {
      if (condition(sortedProbes[i].temperature)) {
        if (currentRunStartIdx === -1) {
          currentRunStartIdx = i;
        }
      } else {
        if (currentRunStartIdx !== -1) {
          const runDuration = new Date(sortedProbes[i - 1].collectedAt).getTime() -
            new Date(sortedProbes[currentRunStartIdx].collectedAt).getTime();
          const maxDuration = (maxRunEndIdx >= 0 && maxRunStartIdx >= 0) ?
            new Date(sortedProbes[maxRunEndIdx].collectedAt).getTime() -
            new Date(sortedProbes[maxRunStartIdx].collectedAt).getTime() : 0;

          if (runDuration > maxDuration) {
            maxRunStartIdx = currentRunStartIdx;
            maxRunEndIdx = i - 1;
          }
          currentRunStartIdx = -1;
        }
      }
    }

    if (currentRunStartIdx !== -1) {
      const lastIdx = sortedProbes.length - 1;
      const runDuration = new Date(sortedProbes[lastIdx].collectedAt).getTime() -
        new Date(sortedProbes[currentRunStartIdx].collectedAt).getTime();
      const maxDuration = (maxRunEndIdx >= 0 && maxRunStartIdx >= 0) ?
        new Date(sortedProbes[maxRunEndIdx].collectedAt).getTime() -
        new Date(sortedProbes[maxRunStartIdx].collectedAt).getTime() : 0;

      if (runDuration > maxDuration) {
        maxRunStartIdx = currentRunStartIdx;
        maxRunEndIdx = lastIdx;
      }
    }

    if (maxRunStartIdx === -1 || maxRunEndIdx === -1) {
      return { sustained: false, startAt: null, latest: null };
    }

    const runDurationMs = new Date(sortedProbes[maxRunEndIdx].collectedAt).getTime() -
      new Date(sortedProbes[maxRunStartIdx].collectedAt).getTime();

    if (runDurationMs >= durationMinutes * 60 * 1000) {
      return {
        sustained: true,
        startAt: sortedProbes[maxRunStartIdx].collectedAt,
        latest: sortedProbes[maxRunEndIdx]
      };
    }

    return { sustained: false, startAt: null, latest: null };
  }

  private buildProbeComparison(
    triggerProbe: ProbeSnapshot,
    ctx: RuleMatchContext,
    rule?: AlertRule
  ): ProbeComparison {
    const adjacentProbes: ProbeComparison['adjacentProbes'] = [];

    for (const [location, snapshots] of ctx.latestByLocation) {
      if (location === triggerProbe.probeLocation) continue;
      const latestByProbe = this.getLatestByProbe(snapshots);
      for (const [, snap] of latestByProbe) {
        adjacentProbes.push({
          probeId: snap.probeId,
          location: snap.probeLocation,
          temp: snap.temperature,
          diff: Math.round((snap.temperature - triggerProbe.temperature) * 10) / 10
        });
      }
    }

    const probesByLocation: ProbeComparison['probesByLocation'] = {};
    for (const [location, snapshots] of ctx.latestByLocation) {
      const latestByProbe = this.getLatestByProbe(snapshots);
      probesByLocation[location] = [];
      for (const [, snap] of latestByProbe) {
        let stable = true;
        if (rule && location === rule.probeLocation) {
          stable = !(snap.temperature > rule.thresholdTemp);
        } else if (rule && location === rule.compareProbeLocation && rule.compareThreshold != null) {
          stable = snap.temperature <= rule.compareThreshold;
        }
        probesByLocation[location].push({
          probeId: snap.probeId,
          temp: snap.temperature,
          stable
        });
      }
    }

    const locationSummary: ProbeComparison['locationSummary'] = {};
    for (const [location, snapshots] of ctx.latestByLocation) {
      const temps = snapshots.map(s => s.temperature);
      locationSummary[location] = {
        count: temps.length,
        avgTemp: Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 10) / 10,
        minTemp: Math.min(...temps),
        maxTemp: Math.max(...temps)
      };
    }

    return {
      triggerProbe: {
        probeId: triggerProbe.probeId,
        location: triggerProbe.probeLocation,
        temp: triggerProbe.temperature
      },
      adjacentProbes,
      probesByLocation,
      locationSummary
    };
  }

  private async handleAlertTrigger(
    rule: AlertRule,
    ctx: RuleMatchContext,
    result: AlertResult
  ): Promise<void> {
    const shipment = ctx.shipment;

    const existingAlert = await prisma.alertRecord.findFirst({
      where: {
        shipmentId: shipment.id,
        alertRuleId: rule.id,
        status: { in: [AlertStatus.PENDING, AlertStatus.CONFIRMED, AlertStatus.ACKNOWLEDGED] }
      }
    });

    const comp = result.probeComparison as any;
    if (result.triggeredProbes && result.triggeredProbes.length > 0) {
      comp.triggeredProbes = result.triggeredProbes;
      comp.triggeredProbeCount = result.triggeredProbes.length;
    }

    if (existingAlert) {
      const updated = await prisma.alertRecord.update({
        where: { id: existingAlert.id },
        data: {
          triggerTemp: result.triggerProbe!.temperature,
          probeComparison: JSON.stringify(comp),
          durationSeconds: result.durationSeconds!,
          confirmedAt: existingAlert.confirmedAt || new Date()
        }
      });

      if (result.alertLevel && existingAlert.alertLevel !== result.alertLevel) {
        await this.notificationService.dispatchNotifications(updated, rule, ctx);
      }

      logger.info(`更新告警记录 #${existingAlert.id}: 触发${result.triggeredProbes?.length || 1}个探头, 持续 ${Math.round((result.durationSeconds || 0) / 60)} 分钟, 当前 ${result.triggerProbe!.temperature}°C`);
      return;
    }

    const alertRecord = await prisma.alertRecord.create({
      data: {
        alertRuleId: rule.id,
        shipmentId: shipment.id,
        customerId: shipment.customerId,
        alertLevel: result.alertLevel!,
        probeId: result.triggerProbe!.probeId,
        probeLocation: result.triggerProbe!.probeLocation,
        triggerTemp: result.triggerProbe!.temperature,
        probeComparison: JSON.stringify(comp),
        durationSeconds: result.durationSeconds!,
        firstTriggeredAt: result.firstTriggeredAt!,
        confirmedAt: new Date(),
        status: AlertStatus.CONFIRMED
      }
    });

    logger.info(`创建告警记录 #${alertRecord.id}: ${rule.name} - 触发${result.triggeredProbes?.length || 1}个探头, ${result.triggerProbe!.temperature}°C, 持续 ${Math.round((result.durationSeconds || 0) / 60)} 分钟`);

    await this.notificationService.dispatchNotifications(alertRecord, rule, ctx);
  }

  private async resolveAutoRecoveredAlerts(
    shipmentId: number,
    rules: AlertRule[],
    ctx: RuleMatchContext
  ): Promise<void> {
    const activeAlerts = await prisma.alertRecord.findMany({
      where: {
        shipmentId,
        alertRuleId: { in: rules.map(r => r.id) },
        status: { in: [AlertStatus.PENDING, AlertStatus.CONFIRMED, AlertStatus.ACKNOWLEDGED] }
      },
      include: { alertRule: true }
    });

    for (const alert of activeAlerts) {
      const rule = alert.alertRule;
      const result = this.evaluateRule(rule, ctx);

      if (!result.triggered) {
        const probes = ctx.latestByLocation.get(alert.probeLocation) || [];
        const probe = probes.find(p => p.probeId === alert.probeId);
        if (probe) {
          await prisma.alertRecord.update({
            where: { id: alert.id },
            data: {
              status: AlertStatus.RESOLVED,
              resolvedAt: new Date(),
              handleResult: 'AUTO_RECOVERED',
              handleRemark: `温度自动恢复正常，当前温度 ${probe.temperature}°C`
            }
          });
          logger.info(`告警 #${alert.id} 已自动恢复: ${probe.temperature}°C`);
        }
      }
    }
  }
}

export const alertEngine = new AlertEngineService();
