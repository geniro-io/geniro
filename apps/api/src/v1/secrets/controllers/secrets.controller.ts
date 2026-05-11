import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import { EntityUUIDDto } from '../../../utils/dto/misc.dto';
import {
  CreateSecretDto,
  SecretResponseDto,
  UpdateSecretDto,
} from '../dto/secrets.dto';
import { SecretsService } from '../services/secrets.service';

@ApiTags('secrets')
@Controller('secrets')
@ApiBearerAuth()
@OnlyForAuthorized()
export class SecretsController {
  constructor(private readonly secretsService: SecretsService) {}

  @Post()
  @ApiCreatedResponse({ type: SecretResponseDto })
  async create(
    @Body() dto: CreateSecretDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<SecretResponseDto> {
    return await this.secretsService.create(ctx, dto);
  }

  @Get()
  @ApiOkResponse({ type: SecretResponseDto, isArray: true })
  async list(
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<SecretResponseDto[]> {
    return await this.secretsService.list(ctx);
  }

  @Get(':id')
  @ApiOkResponse({ type: SecretResponseDto })
  async getById(
    @Param() params: EntityUUIDDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<SecretResponseDto> {
    return await this.secretsService.getById(ctx, params.id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: SecretResponseDto })
  async update(
    @Param() params: EntityUUIDDto,
    @Body() dto: UpdateSecretDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<SecretResponseDto> {
    return await this.secretsService.update(ctx, params.id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(
    @Param() params: EntityUUIDDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<void> {
    return await this.secretsService.delete(ctx, params.id);
  }
}
