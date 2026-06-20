import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/response';
import logger from '../utils/logger';

export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string = '资源未找到') {
    super(message, 404);
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = '请求参数错误') {
    super(message, 400);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message: string = '未授权访问') {
    super(message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string = '没有权限访问') {
    super(message, 403);
  }
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  logger.error(`${req.method} ${req.path} - ${err.message}`, {
    stack: err.stack,
    body: req.body,
    query: req.query,
    params: req.params
  });

  if (err.isOperational) {
    errorResponse(res, err.message, err.statusCode);
    return;
  }

  if (err.name === 'PrismaClientKnownRequestError') {
    if (err.code === 'P2002') {
      errorResponse(res, '数据已存在，违反唯一约束', 409);
      return;
    }
    if (err.code === 'P2025') {
      errorResponse(res, '操作的记录不存在', 404);
      return;
    }
    errorResponse(res, '数据库操作错误', 500);
    return;
  }

  if (err.name === 'ValidationError' || err.type === 'express_validation') {
    errorResponse(res, '请求参数验证失败', 400, err.mapped ? err.mapped() : err.errors);
    return;
  }

  errorResponse(res, '服务器内部错误', 500);
}

export function notFoundHandler(req: Request, res: Response): void {
  errorResponse(res, `接口不存在: ${req.method} ${req.path}`, 404);
}
