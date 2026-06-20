import { Request, Response, NextFunction } from 'express';
import { validationResult } from 'express-validator';
import { errorResponse } from '../utils/response';

export function validateRequest(req: Request, res: Response, next: NextFunction): void {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map((e: any) => ({
      field: e.path || e.param,
      message: e.msg,
      value: e.value
    }));
    errorResponse(res, '请求参数验证失败', 400, formattedErrors);
    return;
  }
  next();
}

export function parsePagination(req: Request): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize as string) || 20));
  const skip = (page - 1) * pageSize;
  return { page, pageSize, skip };
}
