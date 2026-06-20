# 冷链后端告警服务

面向已有冷链平台、司机 App 和企业微信机器人的专用告警服务，专门接收多点探头数据并分级推送异常。

## 功能特性

### 核心模块
1. **规则配置台** - 运营人员按客户、车型、货品温区灵活设置告警规则
2. **告警记录查询** - 完整记录触发探头、相邻探头对比、持续时长和处理结果

### 智能判断机制
- **多点位联合判断** - 同一车次多探头数据合并分析，避免单点抖动误报
- **持续时长检测** - 支持按分钟配置持续超温才触发，过滤瞬时波动
- **分级告警** - 四级告警(关注/警告/严重/紧急)差异化推送
- **相邻探头对比** - 门边突升但货心稳定时只发关注提示，不骚扰司机

### 多渠道差异化通知
| 角色 | 通知渠道 | 措辞风格 |
|------|---------|---------|
| 司机 | 司机App推送 | 简明操作指引 |
| 调度员 | 企业微信+平台回调 | 完整上下文+处理要求 |
| 客户质控 | 企业微信+短信+平台 | 专业数据+品质关注点 |
| 运营/管理员 | 平台+企业微信 | 全量信息摘要 |

## 技术栈
- **运行时**: Node.js 18+
- **语言**: TypeScript 5.5
- **Web框架**: Express 4.19
- **ORM**: Prisma 5.18
- **数据库**: SQLite (生产可切换PostgreSQL/MySQL)
- **日志**: Winston
- **HTTP客户端**: Axios

## 快速开始

### 1. 一键初始化
```bash
npm run setup
```
> 自动安装依赖、生成 Prisma Client、初始化数据库并执行迁移

### 2. 导入种子数据 (可选，推荐)
```bash
npx prisma db seed
```
> 预置2个客户、2辆车、5个用户、2个车次、5条示例告警规则

### 3. 启动开发服务器
```bash
npm run dev
```
> 服务启动于 http://localhost:3000，支持热更新

### 4. 生产构建
```bash
npm run build
npm start
```

## API 接口一览

### 基础服务
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 服务信息 |
| GET | `/api/v1/health` | 健康检查 |
| GET | `/api/v1/health/stats` | 全局统计数据 |

### 探头数据
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/probes/ingest` | 单探头数据接收(触发告警判断) |
| POST | `/api/v1/probes/batch` | 批量数据接收 |
| GET | `/api/v1/probes` | 探头数据分页查询 |
| GET | `/api/v1/probes/shipment/:shipmentNo/summary` | 车次多点位温度汇总 |

### 告警规则配置台
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/alert-rules` | 创建规则 |
| GET | `/api/v1/alert-rules` | 规则列表(支持多条件筛选) |
| GET | `/api/v1/alert-rules/:id` | 规则详情+关联告警 |
| PUT | `/api/v1/alert-rules/:id` | 更新规则 |
| PATCH | `/api/v1/alert-rules/:id/status` | 启用/停用规则 |
| DELETE | `/api/v1/alert-rules/:id` | 删除规则(仅未使用) |
| POST | `/api/v1/alert-rules/clone/:id` | 克隆规则(默认停用) |
| GET | `/api/v1/alert-rules/meta/enums` | 枚举字典 |

### 告警记录查询
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/alert-records` | 告警记录分页查询 |
| GET | `/api/v1/alert-records/:id` | 告警详情(含温度趋势图数据) |
| PATCH | `/api/v1/alert-records/:id/acknowledge` | 确认接收告警 |
| PATCH | `/api/v1/alert-records/:id/resolve` | 处理完成 |
| PATCH | `/api/v1/alert-records/:id/close` | 关闭告警 |
| PATCH | `/api/v1/alert-records/:id/false-alarm` | 标记误报 |
| POST | `/api/v1/alert-records/:id/re-notify` | 重新派发通知 |
| GET | `/api/v1/alert-records/stats/summary` | 告警统计概览 |
| POST | `/api/v1/alert-records/shipment/:shipmentId/re-evaluate` | 手动重评估车次 |

### 基础数据管理
| 模块 | 基础路径 | CRUD | 额外接口 |
|------|---------|------|---------|
| 客户 | `/api/v1/customers` | ✅ | `GET /list/simple` |
| 车辆 | `/api/v1/vehicles` | ✅ | `GET /list/simple`, `GET /types` |
| 用户 | `/api/v1/users` | ✅ | `POST /login`, `GET /list/drivers`, `GET /roles`, `PATCH /:id/password` |
| 车次 | `/api/v1/shipments` | ✅ | `GET /active`, `PATCH /:shipmentNo/status`, `GET /no/:shipmentNo` |
| 通知 | `/api/v1/notifications` | 只读 | `GET /stats/channel`, `POST /retry`, `POST /:id/retry`, `PATCH /:id/ack` |

## 告警规则示例

### 示例1: 冷冻品货心温度监控
```json
{
  "name": "冷冻品-货心温度过高",
  "description": "冷冻品任一货心探头高于-15℃持续10分钟触发警告",
  "customerId": 1,
  "temperatureZone": "FROZEN",
  "probeLocation": "CARGO_CORE",
  "conditionType": "TEMPERATURE_ABOVE",
  "operator": ">",
  "thresholdTemp": -15,
  "durationMinutes": 10,
  "alertLevel": "WARNING",
  "notifyRoles": ["DRIVER", "DISPATCHER", "QC_CUSTOMER"],
  "priority": 10,
  "isActive": true
}
```

### 示例2: 门边突升但货心稳定
```json
{
  "name": "门边探头突升提醒",
  "description": "门边温度突升但货心稳定，仅提示调度关注",
  "customerId": 1,
  "temperatureZone": "FROZEN",
  "probeLocation": "DOOR",
  "conditionType": "TEMPERATURE_SPIKE_WITH_COMPARE",
  "operator": ">",
  "thresholdTemp": -5,
  "compareProbeLocation": "CARGO_CORE",
  "compareThreshold": -15,
  "durationMinutes": 5,
  "alertLevel": "ATTENTION",
  "notifyRoles": ["DISPATCHER"],
  "priority": 5,
  "isActive": true
}
```

### 支持的条件类型
| 类型 | 说明 | 配套字段 |
|------|------|---------|
| `TEMPERATURE_ABOVE` | 温度高于阈值 | `thresholdTemp`, `durationMinutes` |
| `TEMPERATURE_BELOW` | 温度低于阈值 | 同上 |
| `TEMPERATURE_SPIKE_WITH_COMPARE` | 某探头超温但对比探头正常(门边场景) | `compareProbeLocation`, `compareThreshold` |
| `DIFF_WITH_COMPARE` | 两探头温差过大(机组检查) | `compareProbeLocation` |
| `ANY_ABOVE` | 任一该类型探头超温 | `thresholdTemp` |

## 探头位置类型
- `CARGO_CORE` - 货心(最关键，优先监控)
- `DOOR` - 门边(易受开门影响)
- `RETURN_AIR` - 回风(反映机组工况)
- `EVAPORATOR` - 蒸发器
- `AMBIENT` - 环境温度
- `CUSTOM` - 自定义点位

## 温区类型
| 类型 | 典型温度范围 | 说明 |
|------|-------------|------|
| `FROZEN` | -25℃ ~ -18℃ | 冷冻品(肉类、速冻食品) |
| `CHILLED` | 2℃ ~ 8℃ | 冷藏品(果蔬、乳制品) |
| `CONSTANT_TEMP` | 15℃ ~ 25℃ | 恒温品(生物医药) |
| `DUAL_TEMP` | 多温区混装 | |

## 环境变量配置
在 `.env` 文件中配置：
```env
PORT=3000
DATABASE_URL="file:./dev.db"

# 企业微信机器人Webhook
WECHAT_WORK_WEBHOOK_URL="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"

# 冷链平台回调地址(同步告警数据)
COLD_CHAIN_PLATFORM_CALLBACK="https://your-platform.com/api/alerts/callback"

# 司机App推送服务
DRIVER_APP_PUSH_URL="https://your-push-server.com/send"
```

## 典型调用流程

```
1. 探头采集 → POST /api/v1/probes/ingest
      ↓
2. 服务接收入库 → Prisma 写入 ProbeData
      ↓
3. 规则引擎判断:
   - 拉取车次近60分钟所有点位数据
   - 按优先级遍历匹配规则
   - 检查持续时长/相邻探头条件
      ↓
4. 触发告警:
   - 去重: 已有激活告警则仅更新时长
   - 新建 AlertRecord
   - 生成多点位对比快照
      ↓
5. 多渠道通知分发:
   - 按规则指定角色 → 查询目标用户
   - 按角色生成差异化文案
   - 各渠道独立发送(企业微信/APP/平台回调)
      ↓
6. 温度恢复 → 自动标记 RESOLVED
      ↓
7. 运营处理 → PATCH /alert-records/:id/resolve
```

## 种子账号
| 用户名 | 密码 | 角色 | 说明 |
|--------|------|------|------|
| admin | admin123 | 系统管理员 | 全权限 |
| operator01 | 123456 | 运营人员 | 规则配置、告警处理 |
| driver01 | 123456 | 司机 | 接收App推送 |
| dispatch01 | 123456 | 调度员 | 接收企业微信通知 |
| qc001 | 123456 | 客户质控 | 顺丰冷链质控 |

## 目录结构
```
├── prisma/
│   ├── schema.prisma    # 数据模型
│   └── seed.ts          # 种子数据
├── src/
│   ├── config/          # 配置(Prisma/环境变量)
│   ├── middleware/      # 中间件(错误处理/参数校验)
│   ├── routes/          # API路由(10个模块)
│   ├── services/        # 核心业务服务
│   │   ├── alertEngine.service.ts     # 规则引擎(最核心)
│   │   ├── notification.service.ts    # 多渠道通知
│   │   └── alertRetry.service.ts      # 失败重试
│   ├── utils/           # 工具(日志/响应)
│   ├── app.ts           # Express应用组装
│   └── server.ts        # 入口
├── logs/                # 日志(自动创建)
├── .env                 # 环境变量
├── tsconfig.json
└── package.json
```

## 设计要点

1. **防抖策略**：持续时长检测 + 多点位验证双重保障，杜绝瞬间抖动
2. **去重逻辑**：同一规则+同一探头+未关闭告警仅产生一条记录，自动更新时长
3. **自动恢复**：下次数据送达时自动检查，温度正常则标记 AUTO_RECOVERED
4. **失败重试**：独立定时器定时重发失败通知，最多3次重试
5. **角色隔离**：不同角色看到的告警措辞完全不同，减少信息噪音
6. **完整溯源**：每条告警保留探头对比快照，支持事后分析"为何此时触发"
