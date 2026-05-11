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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { OnlyForAuthorized } from '@packages/http-server';

import { environment } from '../../../environments';
import {
  CreateLiteLlmCredentialDto,
  CreateLiteLlmModelDto,
  LiteLlmCredentialsResponseDto,
  LiteLlmModelInfoItemDto,
  LiteLlmProvidersResponseDto,
  TestModelConnectionDto,
  TestModelRequestDto,
  TestModelResponseDto,
  UpdateLiteLlmModelDto,
} from '../dto/models.dto';
import { LiteLlmAdminService } from '../services/litellm-admin.service';

@Controller('litellm')
@ApiTags('litellm')
@ApiBearerAuth()
@OnlyForAuthorized({ roles: [environment.adminRole] })
export class LiteLlmAdminController {
  constructor(private readonly adminService: LiteLlmAdminService) {}

  @Get('/models/info')
  @ApiOperation({ summary: 'List all LiteLLM models with full config (admin)' })
  @ApiOkResponse({ type: LiteLlmModelInfoItemDto, isArray: true })
  async listModelsInfo(): Promise<LiteLlmModelInfoItemDto[]> {
    return this.adminService.listModelsInfo();
  }

  @Post('/models/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Test a registered model connection' })
  @ApiOkResponse({ type: TestModelResponseDto })
  async testModel(
    @Body() dto: TestModelRequestDto,
  ): Promise<TestModelResponseDto> {
    return this.adminService.testModel(dto.model);
  }

  @Post('/models/test-connection')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Test a model connection with inline config (no registration)',
  })
  @ApiOkResponse({ type: TestModelResponseDto })
  async testModelConnection(
    @Body() dto: TestModelConnectionDto,
  ): Promise<TestModelResponseDto> {
    return this.adminService.testModelConnection(dto);
  }

  @Post('/models')
  @HttpCode(201)
  @ApiOperation({ summary: 'Add a new LiteLLM model' })
  async createModel(@Body() dto: CreateLiteLlmModelDto): Promise<void> {
    await this.adminService.createModel(dto);
  }

  @Patch('/models')
  @HttpCode(200)
  @ApiOperation({ summary: 'Update an existing LiteLLM model' })
  async updateModel(@Body() dto: UpdateLiteLlmModelDto): Promise<void> {
    await this.adminService.updateModel(dto);
  }

  @Delete('/models/:id')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a LiteLLM model by database ID' })
  async deleteModel(@Param('id') id: string): Promise<void> {
    await this.adminService.deleteModel(id);
  }

  @Get('/providers')
  @ApiOperation({ summary: 'List available LLM providers' })
  @ApiOkResponse({ type: LiteLlmProvidersResponseDto })
  async listProviders(): Promise<LiteLlmProvidersResponseDto> {
    return this.adminService.listProviders();
  }

  @Get('/credentials')
  @ApiOperation({ summary: 'List saved LiteLLM credentials' })
  @ApiOkResponse({ type: LiteLlmCredentialsResponseDto })
  async listCredentials(): Promise<LiteLlmCredentialsResponseDto> {
    return this.adminService.listCredentials();
  }

  @Post('/credentials')
  @HttpCode(201)
  @ApiOperation({ summary: 'Create a new named credential' })
  async createCredential(
    @Body() dto: CreateLiteLlmCredentialDto,
  ): Promise<void> {
    await this.adminService.createCredential(dto);
  }

  @Delete('/credentials/:name')
  @HttpCode(200)
  @ApiOperation({ summary: 'Delete a named credential' })
  async deleteCredential(@Param('name') name: string): Promise<void> {
    await this.adminService.deleteCredential(name);
  }
}
