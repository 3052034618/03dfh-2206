import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import fs from 'fs';

import { config } from './config';
import logger from './utils/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';

import probeRoutes from './routes/probe.routes';
import alertRuleRoutes from './routes/alertRule.routes';
import alertRecordRoutes from './routes/alertRecord.routes';
import customerRoutes from './routes/customer.routes';
import vehicleRoutes from './routes/vehicle.routes';
import userRoutes from './routes/user.routes';
import shipmentRoutes from './routes/shipment.routes';
import notificationRoutes from './routes/notification.routes';
import healthRoutes from './routes/health.routes';

const app = express();

const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(morgan('combined', {
  stream: {
    write: (message: string) => logger.info(message.trim())
  }
}));

app.get('/', (req, res) => {
  res.json({
    name: '冷链告警服务',
    version: '1.0.0',
    description: '多点探头数据分级推送异常服务',
    status: 'running',
    timestamp: new Date().toISOString()
  });
});

app.use('/api/v1/health', healthRoutes);
app.use('/api/v1/probes', probeRoutes);
app.use('/api/v1/alert-rules', alertRuleRoutes);
app.use('/api/v1/alert-records', alertRecordRoutes);
app.use('/api/v1/customers', customerRoutes);
app.use('/api/v1/vehicles', vehicleRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/shipments', shipmentRoutes);
app.use('/api/v1/notifications', notificationRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
