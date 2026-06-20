import { Response } from 'express';

export interface ApiResponse<T = any> {
  success: boolean;
  code: number;
  message: string;
  data?: T;
  timestamp: number;
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export function successResponse<T>(
  res: Response,
  data: T,
  message: string = 'success',
  code: number = 200
): Response {
  const response: ApiResponse<T> = {
    success: true,
    code,
    message,
    data,
    timestamp: Date.now()
  };
  return res.status(code).json(response);
}

export function paginatedResponse<T>(
  res: Response,
  data: T[],
  page: number,
  pageSize: number,
  total: number,
  message: string = 'success',
  code: number = 200
): Response {
  const response: ApiResponse<T[]> = {
    success: true,
    code,
    message,
    data,
    timestamp: Date.now(),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize)
    }
  };
  return res.status(code).json(response);
}

export function errorResponse(
  res: Response,
  message: string,
  code: number = 400,
  errors?: any
): Response {
  const response: ApiResponse = {
    success: false,
    code,
    message,
    timestamp: Date.now(),
    data: errors
  };
  return res.status(code).json(response);
}
