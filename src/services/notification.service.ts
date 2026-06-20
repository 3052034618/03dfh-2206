import {
  AlertRecord,
  AlertRule,
  User
} from '@prisma/client';
import {
  UserRole,
  NotificationChannel,
  NotificationStatus
} from '../types/enums';
import prisma from '../config/prisma';
import logger from '../utils/logger';
import { config } from '../config';
import axios from 'axios';
import { RuleMatchContext } from './alertEngine.service';

type AlertRecordWithRelations = AlertRecord & {
  shipment?: {
    shipmentNo: string;
    vehicle?: { plateNumber: string; vehicleType: string };
    driver?: { realName: string; phone: string };
  };
  customer?: { name: string; wechatGroup?: string };
  alertRule?: { name: string; description?: string };
};

interface NotifyRoleConfig {
  role: string;
  channels: string[];
}

const LEVEL_COLORS: Record<string, string> = {
  ATTENTION: 'info',
  WARNING: 'warning',
  CRITICAL: 'danger',
  FATAL: 'danger'
};

const LEVEL_LABELS: Record<string, string> = {
  ATTENTION: '关注',
  WARNING: '警告',
  CRITICAL: '严重',
  FATAL: '紧急'
};

const LEVEL_EMOJIS: Record<string, string> = {
  ATTENTION: 'ℹ️',
  WARNING: '⚠️',
  CRITICAL: '🚨',
  FATAL: '🔴'
};

export class NotificationService {
  private roleChannelMap: Record<string, NotifyRoleConfig> = {
    [UserRole.DRIVER]: {
      role: UserRole.DRIVER,
      channels: [NotificationChannel.DRIVER_APP]
    },
    [UserRole.DISPATCHER]: {
      role: UserRole.DISPATCHER,
      channels: [NotificationChannel.WECHAT_WORK, NotificationChannel.COLD_CHAIN_PLATFORM]
    },
    [UserRole.QC_CUSTOMER]: {
      role: UserRole.QC_CUSTOMER,
      channels: [NotificationChannel.WECHAT_WORK, NotificationChannel.COLD_CHAIN_PLATFORM, NotificationChannel.SMS]
    },
    [UserRole.ADMIN]: {
      role: UserRole.ADMIN,
      channels: [NotificationChannel.COLD_CHAIN_PLATFORM]
    },
    [UserRole.OPERATOR]: {
      role: UserRole.OPERATOR,
      channels: [NotificationChannel.WECHAT_WORK, NotificationChannel.COLD_CHAIN_PLATFORM]
    }
  };

  async dispatchNotifications(
    alertRecord: AlertRecord,
    rule: AlertRule,
    ctx: RuleMatchContext
  ): Promise<void> {
    try {
      const notifyRoles = this.parseNotifyRoles(rule.notifyRoles);
      const users = await this.getRecipientUsers(notifyRoles, ctx);

      const fullAlert = await prisma.alertRecord.findUnique({
        where: { id: alertRecord.id },
        include: {
          shipment: {
            include: {
              vehicle: true,
              driver: true
            }
          },
          customer: true,
          alertRule: true
        }
      }) as AlertRecordWithRelations;

      for (const user of users) {
        const roleConfig = this.roleChannelMap[user.role];
        if (!roleConfig) continue;

        for (const channel of roleConfig.channels) {
          await this.createAndSendNotification(
            fullAlert,
            rule,
            user,
            channel,
            ctx
          );
        }
      }

      logger.info(`告警 #${alertRecord.id} 通知派发完成, 涉及用户: ${users.length}`);
    } catch (error: any) {
      logger.error(`派发告警 #${alertRecord.id} 通知失败:`, error);
    }
  }

  private parseNotifyRoles(notifyRolesStr: string): string[] {
    try {
      const parsed = JSON.parse(notifyRolesStr);
      if (Array.isArray(parsed)) {
        return parsed.filter(r => Object.values(UserRole).includes(r));
      }
    } catch {}
    return [UserRole.DISPATCHER, UserRole.DRIVER];
  }

  private async getRecipientUsers(roles: string[], ctx: RuleMatchContext): Promise<User[]> {
    const whereClauses: any[] = [];

    for (const role of roles) {
      if (role === UserRole.DRIVER && ctx.shipment.driverId) {
        whereClauses.push({ id: ctx.shipment.driverId });
      } else if (role === UserRole.QC_CUSTOMER) {
        whereClauses.push({
          role,
          customerId: ctx.shipment.customerId,
          isActive: true
        });
      } else if (role === UserRole.DISPATCHER || role === UserRole.OPERATOR || role === UserRole.ADMIN) {
        whereClauses.push({
          role,
          isActive: true
        });
      }
    }

    if (whereClauses.length === 0) return [];

    return prisma.user.findMany({
      where: {
        OR: whereClauses
      }
    });
  }

  private async createAndSendNotification(
    alert: AlertRecordWithRelations,
    rule: AlertRule,
    user: User,
    channel: string,
    ctx: RuleMatchContext
  ): Promise<void> {
    const content = this.generateContent(alert, rule, user.role, channel, ctx);
    const recipient = this.getRecipient(user, channel);

    const notification = await prisma.alertNotification.create({
      data: {
        alertRecordId: alert.id,
        userId: user.id,
        role: user.role,
        channel,
        recipient,
        content,
        status: NotificationStatus.PENDING
      }
    });

    try {
      await this.sendViaChannel(notification, channel, content, recipient, user);

      await prisma.alertNotification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.SENT,
          sentAt: new Date(),
          retryCount: { increment: 0 }
        }
      });

      logger.debug(`通知已发送 [${channel}] -> ${user.realName}(${user.role}): 告警 #${alert.id}`);
    } catch (error: any) {
      logger.error(`通知发送失败 [${channel}] -> ${user.realName}:`, error.message);
      await prisma.alertNotification.update({
        where: { id: notification.id },
        data: {
          status: NotificationStatus.FAILED,
          errorMessage: error.message?.substring(0, 500),
          retryCount: { increment: 1 }
        }
      });
    }
  }

  private generateContent(
    alert: AlertRecordWithRelations,
    rule: AlertRule,
    role: string,
    channel: string,
    ctx: RuleMatchContext
  ): string {
    const shipment = alert.shipment;
    const customer = alert.customer;
    const levelLabel = LEVEL_LABELS[alert.alertLevel];
    const emoji = LEVEL_EMOJIS[alert.alertLevel];
    const durationMin = Math.round((alert.durationSeconds || 0) / 60);
    const plateNo = shipment?.vehicle?.plateNumber || '未知车辆';
    const shipmentNo = shipment?.shipmentNo || '未知车次';
    const driverName = shipment?.driver?.realName || '未指派';

    const probeInfo = this.formatProbeInfo(alert);
    const comparisonInfo = this.formatComparisonInfo(alert);

    switch (role) {
      case UserRole.DRIVER:
        return this.formatDriverMessage(emoji, levelLabel, alert, durationMin, plateNo, probeInfo, comparisonInfo);

      case UserRole.DISPATCHER:
        return this.formatDispatcherMessage(emoji, levelLabel, alert, durationMin, plateNo, shipmentNo, driverName, probeInfo, comparisonInfo, rule);

      case UserRole.QC_CUSTOMER:
        return this.formatQCMessage(emoji, levelLabel, alert, durationMin, plateNo, shipmentNo, probeInfo, comparisonInfo, rule, customer?.name);

      case UserRole.OPERATOR:
      case UserRole.ADMIN:
      default:
        return this.formatOperatorMessage(emoji, levelLabel, alert, durationMin, plateNo, shipmentNo, driverName, probeInfo, comparisonInfo, rule, customer?.name);
    }
  }

  private formatProbeInfo(alert: AlertRecordWithRelations): string {
    const locationMap: Record<string, string> = {
      CARGO_CORE: '货心',
      DOOR: '门边',
      RETURN_AIR: '回风',
      EVAPORATOR: '蒸发器',
      AMBIENT: '环境',
      CUSTOM: '自定义'
    };
    const location = locationMap[alert.probeLocation] || alert.probeLocation;
    return `${location}探头#${alert.probeId.substring(0, 8)} (${alert.triggerTemp.toFixed(1)}°C)`;
  }

  private formatComparisonInfo(alert: AlertRecordWithRelations): string {
    const comp: any = alert.probeComparison;
    if (!comp || !comp.locationSummary) return '';

    const locationMap: Record<string, string> = {
      CARGO_CORE: '货心',
      DOOR: '门边',
      RETURN_AIR: '回风',
      EVAPORATOR: '蒸发器',
      AMBIENT: '环境',
      CUSTOM: '自定义'
    };

    const parts: string[] = [];
    for (const [loc, summary] of Object.entries<any>(comp.locationSummary)) {
      const locName = locationMap[loc] || loc;
      parts.push(`${locName}:${summary.avgTemp?.toFixed(1)}°C`);
    }

    if (comp.note) parts.push(comp.note);
    if (comp.violatingCount) parts.push(`超温探头数量:${comp.violatingCount}`);

    return parts.length > 0 ? `[${parts.join(' | ')}]` : '';
  }

  private formatDriverMessage(
    emoji: string, levelLabel: string,
    alert: AlertRecordWithRelations, durationMin: number,
    plateNo: string, probeInfo: string, comparisonInfo: string
  ): string {
    const severity = alert.alertLevel === 'ATTENTION' ? '请注意检查' : '请立即处理';
    const suggestion = this.getActionSuggestion(alert);

    return `${emoji}【${levelLabel}】冷链温度异常 ${severity}\n` +
      `车牌: ${plateNo}\n` +
      `异常探头: ${probeInfo}\n` +
      `持续时间: ${durationMin}分钟\n` +
      `${comparisonInfo ? `多点对比: ${comparisonInfo}\n` : ''}` +
      `建议操作: ${suggestion}`;
  }

  private formatDispatcherMessage(
    emoji: string, levelLabel: string,
    alert: AlertRecordWithRelations, durationMin: number,
    plateNo: string, shipmentNo: string, driverName: string,
    probeInfo: string, comparisonInfo: string,
    rule: AlertRule
  ): string {
    return `${emoji}【调度中心-${levelLabel}】温度告警\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `告警类型: ${rule.name}\n` +
      `车次号: ${shipmentNo}\n` +
      `车牌号: ${plateNo}\n` +
      `司机: ${driverName}\n` +
      `触发探头: ${probeInfo}\n` +
      `持续时间: ${durationMin}分钟\n` +
      `${comparisonInfo ? `点位汇总: ${comparisonInfo}\n` : ''}` +
      `告警时间: ${new Date(alert.createdAt).toLocaleString('zh-CN')}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `请及时跟进并在系统中记录处理结果`;
  }

  private formatQCMessage(
    emoji: string, levelLabel: string,
    alert: AlertRecordWithRelations, durationMin: number,
    plateNo: string, shipmentNo: string,
    probeInfo: string, comparisonInfo: string,
    rule: AlertRule,
    customerName?: string
  ): string {
    return `${emoji}【客户质控-${levelLabel}】冷链温度异常通知\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `${customerName ? `客户: ${customerName}\n` : ''}` +
      `告警规则: ${rule.name}\n` +
      `车次: ${shipmentNo}\n` +
      `车辆: ${plateNo}\n` +
      `超温位置: ${probeInfo}\n` +
      `异常持续: ${durationMin}分钟\n` +
      `${comparisonInfo ? `全厢温度: ${comparisonInfo}\n` : ''}` +
      `触发时间: ${new Date(alert.firstTriggeredAt).toLocaleString('zh-CN')}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `${rule.description ? `规则说明: ${rule.description}\n` : ''}` +
      `请关注货物品质状态`;
  }

  private formatOperatorMessage(
    emoji: string, levelLabel: string,
    alert: AlertRecordWithRelations, durationMin: number,
    plateNo: string, shipmentNo: string, driverName: string,
    probeInfo: string, comparisonInfo: string,
    rule: AlertRule,
    customerName?: string
  ): string {
    return `${emoji}【运营台-${levelLabel}】告警ID:${alert.id}\n` +
      `规则[${rule.id}]: ${rule.name}\n` +
      `车次: ${shipmentNo} | 车牌: ${plateNo}\n` +
      `司机: ${driverName}${customerName ? ` | 客户:${customerName}` : ''}\n` +
      `探头: ${probeInfo} | ${durationMin}分钟\n` +
      `${comparisonInfo}`;
  }

  private getActionSuggestion(alert: AlertRecordWithRelations): string {
    switch (alert.alertLevel) {
      case 'ATTENTION':
        return '靠边停车检查车门是否关严，观察温度变化趋势';
      case 'WARNING':
        return '检查冷机运行状态，确认设定温度，必要时联系调度';
      case 'CRITICAL':
        return '立即停车检查冷机故障代码，联系调度安排救援，尽量保持制冷';
      case 'FATAL':
        return '紧急处理！立即联系调度和维修，评估货物受损风险';
      default:
        return '检查车辆制冷情况';
    }
  }

  private getRecipient(user: User, channel: string): string {
    switch (channel) {
      case NotificationChannel.DRIVER_APP:
        return user.id.toString();
      case NotificationChannel.WECHAT_WORK:
        return user.wechatId || user.phone || user.username;
      case NotificationChannel.SMS:
        return user.phone || '';
      case NotificationChannel.EMAIL:
        return user.email || '';
      case NotificationChannel.COLD_CHAIN_PLATFORM:
        return user.username;
      default:
        return user.username;
    }
  }

  private async sendViaChannel(
    notification: any,
    channel: string,
    content: string,
    recipient: string,
    user: User
  ): Promise<void> {
    switch (channel) {
      case NotificationChannel.WECHAT_WORK:
        await this.sendWechatWork(content, recipient);
        break;

      case NotificationChannel.DRIVER_APP:
        await this.sendDriverAppPush(content, user);
        break;

      case NotificationChannel.COLD_CHAIN_PLATFORM:
        await this.sendPlatformCallback(notification, content);
        break;

      case NotificationChannel.SMS:
        logger.info(`[模拟SMS] -> ${recipient}: ${content.substring(0, 100)}...`);
        break;

      case NotificationChannel.EMAIL:
        logger.info(`[模拟Email] -> ${recipient}: ${content.substring(0, 100)}...`);
        break;

      default:
        logger.debug(`[未配置渠道${channel}] ${content.substring(0, 50)}...`);
    }
  }

  private async sendWechatWork(content: string, recipient: string): Promise<void> {
    const webhookUrl = config.wechatWork.webhookUrl;

    if (!webhookUrl) {
      logger.info(`[企业微信-未配置Webhook] @${recipient}: ${content.substring(0, 100)}`);
      return;
    }

    const markdown = this.toWechatMarkdown(content);

    try {
      await axios.post(webhookUrl, {
        msgtype: 'markdown',
        markdown: { content: markdown }
      }, { timeout: 5000 });
    } catch (error: any) {
      logger.warn(`企业微信推送失败，降级为日志记录: ${error.message}`);
      logger.info(`[企业微信-降级] @${recipient}: ${content.substring(0, 100)}`);
    }
  }

  private toWechatMarkdown(text: string): string {
    const boldKeywords = ['【', '】', '告警', '警告', '严重', '紧急', '关注'];
    let result = text;
    boldKeywords.forEach(kw => {
      result = result.replace(new RegExp(kw, 'g'), `**${kw}**`);
    });
    return result;
  }

  private async sendDriverAppPush(content: string, user: User): Promise<void> {
    const pushUrl = config.driverApp.pushUrl;

    if (!pushUrl) {
      logger.info(`[司机App-未配置Push] -> ${user.realName}: ${content.substring(0, 100)}`);
      return;
    }

    try {
      await axios.post(pushUrl, {
        userId: user.id,
        phone: user.phone,
        title: '冷链温度告警',
        body: content,
        type: 'temperature_alert',
        timestamp: Date.now()
      }, { timeout: 5000 });
    } catch (error: any) {
      logger.warn(`司机App推送失败，降级为日志: ${error.message}`);
      logger.info(`[司机App-降级] -> ${user.realName}: ${content.substring(0, 100)}`);
    }
  }

  private async sendPlatformCallback(notification: any, content: string): Promise<void> {
    const callbackUrl = config.coldChainPlatform.callbackUrl;

    if (!callbackUrl) {
      logger.info(`[冷链平台-未配置回调] 通知ID:${notification.id}`);
      return;
    }

    try {
      await axios.post(callbackUrl, {
        notificationId: notification.id,
        alertRecordId: notification.alertRecordId,
        type: 'ALERT_NOTIFICATION',
        content,
        timestamp: Date.now()
      }, { timeout: 10000 });
    } catch (error: any) {
      logger.warn(`冷链平台回调失败: ${error.message}`);
      throw error;
    }
  }

  async retryFailedNotifications(): Promise<{ retried: number; succeeded: number; failed: number }> {
    const failed = await prisma.alertNotification.findMany({
      where: {
        status: NotificationStatus.FAILED,
        retryCount: { lt: config.alert.maxRetryCount }
      }
    });

    let retried = 0;
    let succeeded = 0;

    for (const n of failed) {
      retried++;
      try {
        const user = n.userId ? await prisma.user.findUnique({ where: { id: n.userId } }) : null;
        if (!user) continue;

        await this.sendViaChannel(n, n.channel, n.content, n.recipient, user);

        await prisma.alertNotification.update({
          where: { id: n.id },
          data: {
            status: NotificationStatus.SENT,
            sentAt: new Date(),
            retryCount: { increment: 1 }
          }
        });
        succeeded++;
      } catch (error: any) {
        await prisma.alertNotification.update({
          where: { id: n.id },
          data: {
            retryCount: { increment: 1 },
            errorMessage: error.message?.substring(0, 500)
          }
        });
      }
    }

    return {
      retried,
      succeeded,
      failed: retried - succeeded
    };
  }
}

export const notificationService = new NotificationService();
