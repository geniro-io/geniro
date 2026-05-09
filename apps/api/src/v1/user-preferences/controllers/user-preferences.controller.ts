import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CtxStorage, OnlyForAuthorized } from '@packages/http-server';

import { AppContextStorage } from '../../../auth/app-context-storage';
import {
  UpdateUserPreferencesDto,
  UserPreferencesDto,
} from '../dto/user-preferences.dto';
import { UserPreferencesService } from '../services/user-preferences.service';

@Controller('user-preferences')
@ApiTags('user-preferences')
@ApiBearerAuth()
@OnlyForAuthorized()
export class UserPreferencesController {
  constructor(
    private readonly userPreferencesService: UserPreferencesService,
  ) {}

  @Get()
  @ApiOkResponse({ type: UserPreferencesDto })
  async getPreferences(
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<UserPreferencesDto> {
    return this.userPreferencesService.getPreferences(ctx);
  }

  @Put()
  @ApiOkResponse({ type: UserPreferencesDto })
  async updatePreferences(
    @Body() dto: UpdateUserPreferencesDto,
    @CtxStorage() ctx: AppContextStorage,
  ): Promise<UserPreferencesDto> {
    return this.userPreferencesService.updatePreferences(ctx, dto);
  }
}
