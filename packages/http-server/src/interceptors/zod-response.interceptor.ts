import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import lodash from 'lodash';

const { pick } = lodash;
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import z from 'zod';

type MaybeZodDto =
  | { schema?: z.ZodTypeAny; zodSchema?: never }
  | { schema?: never; zodSchema?: z.ZodTypeAny }
  | { schema?: undefined; zodSchema?: undefined };

const getZod = (dto: MaybeZodDto | undefined): z.ZodTypeAny | undefined =>
  dto?.schema ?? dto?.zodSchema;

@Injectable()
export class ZodResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = (this.reflector.getAllAndOverride('swagger/apiResponse', [
      ctx.getHandler(),
      ctx.getClass(),
    ]) || {}) as Record<string, { type?: MaybeZodDto; isArray?: boolean }>;

    const resp = meta['200'] || meta['201'] || meta['default'];
    const dto = resp?.type as MaybeZodDto | undefined;
    const schema = getZod(dto);
    if (!schema) {
      return next.handle();
    }
    const schemaDef = ((schema as z.ZodObject<z.ZodRawShape>).def?.shape ??
      {}) as Record<string, unknown>;

    const s = resp?.isArray ? z.array(schema) : schema;
    return next.handle().pipe(
      map((d) => {
        const data = s.safeParse(d);

        if (!data.error) {
          return data.data;
        } else {
          // Fallback: when validation fails, return only schema-defined fields.
          // Handle arrays by mapping each item; handle objects by picking keys.
          const keys = Object.keys(schemaDef);

          if (Array.isArray(d)) {
            return d.map((item) =>
              item && typeof item === 'object' ? pick(item, keys) : item,
            );
          }
          return pick(d as Record<string, unknown>, keys);
        }
      }),
    );
  }
}
