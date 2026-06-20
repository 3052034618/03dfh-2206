import { Router, Request, Response } from 'express';
import { body, query, param } from 'express-validator';
import prisma from '../config/prisma';
import { validateRequest, parsePagination } from '../middleware/validate';
import { successResponse, paginatedResponse, errorResponse } from '../utils/response';
import logger from '../utils/logger';
import { UserRoleArray, UserRole } from '../types/enums';

const router = Router();
const validRoles = UserRoleArray;

router.post(
  '/',
  [
    body('username').isString().isLength({ min: 3, max: 50 }).withMessage('用户名3-50字符'),
    body('password').optional().isString().isLength({ min: 6, max: 50 }),
    body('realName').isString().isLength({ min: 2, max: 50 }).withMessage('真实姓名必填'),
    body('role').isIn(validRoles).withMessage(`角色必须是: ${validRoles.join(',')}`),
    body('phone').optional().isString(),
    body('email').optional().isEmail(),
    body('wechatId').optional().isString(),
    body('customerId').optional().isInt().toInt(),
    body('isActive').optional().isBoolean(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const data = { ...req.body };
      if (!data.password) data.password = '123456';

      if (data.customerId) {
        const customer = await prisma.customer.findUnique({ where: { id: data.customerId } });
        if (!customer) return errorResponse(res, '客户不存在', 404);
      }

      const user = await prisma.user.create({ data });
      logger.info(`创建用户: ${user.username} (${user.role})`);
      const { password, ...safe } = user;
      successResponse(res, safe, '用户创建成功', 201);
    } catch (error: any) {
      errorResponse(res, `创建失败: ${error.message}`, 400);
    }
  }
);

router.post(
  '/login',
  [
    body('username').isString().withMessage('用户名必填'),
    body('password').isString().withMessage('密码必填'),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body;
      const user = await prisma.user.findUnique({
        where: { username },
        include: { customer: { select: { id: true, name: true, code: true } } }
      });

      if (!user || !user.isActive) {
        return errorResponse(res, '用户不存在或已禁用', 401);
      }
      if (user.password !== password) {
        return errorResponse(res, '密码错误', 401);
      }

      const { password: _, ...safe } = user;
      successResponse(res, {
        token: `mock_token_${user.id}_${Date.now()}`,
        user: safe
      }, '登录成功');
    } catch (error: any) {
      errorResponse(res, error.message, 500);
    }
  }
);

router.get(
  '/',
  [
    query('role').optional().isIn(validRoles),
    query('customerId').optional().isInt().toInt(),
    query('isActive').optional().isBoolean().toBoolean(),
    query('keyword').optional().isString(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const { page, pageSize, skip } = parsePagination(req);
      const { role, customerId, isActive, keyword } = req.query;

      const where: any = {};
      if (role) where.role = role;
      if (customerId) where.customerId = parseInt(customerId as string);
      if (isActive !== undefined) where.isActive = isActive === 'true';
      if (keyword) {
        where.OR = [
          { username: { contains: keyword as string } },
          { realName: { contains: keyword as string } },
          { phone: { contains: keyword as string } }
        ];
      }

      const [total, data] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: pageSize,
          include: {
            customer: { select: { name: true, code: true } },
            _count: { select: { notifications: true, asDriver: true } }
          }
        })
      ]);

      const formatted = data.map(({ password: _, ...u }) => u);
      paginatedResponse(res, formatted, page, pageSize, total);
    } catch (error: any) {
      errorResponse(res, error.message, 500);
    }
  }
);

router.get('/list/drivers', async (_req: Request, res: Response) => {
  try {
    const drivers = await prisma.user.findMany({
      where: { role: UserRole.DRIVER, isActive: true },
      select: { id: true, username: true, realName: true, phone: true },
      orderBy: { realName: 'asc' }
    });
    successResponse(res, drivers);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.get('/roles', (_req: Request, res: Response) => {
  const roleDesc: Record<string, string> = {
    DRIVER: '司机',
    DISPATCHER: '调度员',
    QC_CUSTOMER: '客户质控',
    ADMIN: '系统管理员',
    OPERATOR: '运营人员'
  };
  successResponse(res, validRoles.map(r => ({ code: r, name: roleDesc[r as keyof typeof roleDesc] })));
});

router.get('/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        customer: { select: { name: true, code: true } },
        notifications: {
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: { alertRecord: { select: { id: true, alertLevel: true, status: true } } }
        }
      }
    });
    if (!user) return errorResponse(res, '用户不存在', 404);
    const { password: _, ...safe } = user;
    successResponse(res, safe);
  } catch (error: any) {
    errorResponse(res, error.message, 500);
  }
});

router.put(
  '/:id',
  [
    param('id').isInt().toInt(),
    body('realName').optional().isString().isLength({ min: 2, max: 50 }),
    body('role').optional().isIn(validRoles),
    body('phone').optional().isString(),
    body('email').optional().isEmail(),
    body('wechatId').optional().isString(),
    body('customerId').optional().isInt().toInt(),
    body('isActive').optional().isBoolean(),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const user = await prisma.user.update({ where: { id }, data: req.body });
      logger.info(`更新用户 #${id}: ${user.username}`);
      const { password: _, ...safe } = user;
      successResponse(res, safe, '用户更新成功');
    } catch (error: any) {
      errorResponse(res, `更新失败: ${error.message}`, 400);
    }
  }
);

router.patch(
  '/:id/password',
  [
    param('id').isInt().toInt(),
    body('password').isString().isLength({ min: 6, max: 50 }).withMessage('密码6-50字符'),
    validateRequest
  ],
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      await prisma.user.update({
        where: { id },
        data: { password: req.body.password }
      });
      logger.info(`修改用户密码 #${id}`);
      successResponse(res, null, '密码修改成功');
    } catch (error: any) {
      errorResponse(res, `修改失败: ${error.message}`, 400);
    }
  }
);

router.delete('/:id', [
  param('id').isInt().toInt(),
  validateRequest
], async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const notifCount = await prisma.alertNotification.count({ where: { userId: id } });
    const shipmentCount = await prisma.shipment.count({ where: { driverId: id } });
    if (notifCount > 0 || shipmentCount > 0) {
      return errorResponse(res, `用户有关联数据(通知${notifCount}, 车次${shipmentCount})，建议停用而非删除`, 400);
    }
    await prisma.user.delete({ where: { id } });
    logger.info(`删除用户 #${id}`);
    successResponse(res, null, '删除成功');
  } catch (error: any) {
    errorResponse(res, `删除失败: ${error.message}`, 400);
  }
});

export default router;
