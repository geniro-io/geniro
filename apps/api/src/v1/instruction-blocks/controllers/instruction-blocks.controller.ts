import { Controller, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { OnlyForAuthorized } from '@packages/http-server';

import { InstructionBlockResponseDto } from '../dto/instruction-blocks.dto';
import { InstructionBlocksService } from '../services/instruction-blocks.service';

@Controller('instruction-blocks')
@ApiTags('instruction-blocks')
@ApiBearerAuth()
@OnlyForAuthorized()
export class InstructionBlocksController {
  constructor(
    private readonly instructionBlocksService: InstructionBlocksService,
  ) {}

  @Get()
  @ApiOperation({ operationId: 'listInstructionBlocks' })
  @ApiOkResponse({ type: InstructionBlockResponseDto, isArray: true })
  async getAll(): Promise<InstructionBlockResponseDto[]> {
    return await this.instructionBlocksService.getAll();
  }

  @Get(':id')
  @ApiOperation({ operationId: 'getInstructionBlockById' })
  @ApiOkResponse({ type: InstructionBlockResponseDto })
  async getById(@Param('id') id: string): Promise<InstructionBlockResponseDto> {
    return await this.instructionBlocksService.getById(id);
  }
}
