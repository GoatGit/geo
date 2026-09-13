import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** 统一错误响应包络:{ error: { code, message } };异常细节只进日志,不回客户端。 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message instanceof Array
              ? (body as { message: string[] }).message.join('; ')
              : ((body as { message?: string }).message ?? exception.message));
      res.status(status).json({ error: { code: status, message } });
      return;
    }
    this.logger.error('unhandled exception', exception as Error);
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ error: { code: 500, message: 'internal error' } });
  }
}
