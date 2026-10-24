import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UnprocessableEntityException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { ParseObjectIdPipe } from '../../common/pipes/parse-object-id.pipe.js';
import { requireEmployeeId } from '../../common/utils/scope.util.js';
import {
  CreateEmployeeDto,
  ExportEmployeesQueryDto,
  ImportEmployeesBodyDto,
  ImportEmployeesQueryDto,
  ListEmployeesQueryDto,
  UpdateEmployeeDto,
  UpdateMyProfileDto,
} from './dto/employee.dto.js';
import { EmployeeImportService } from './employee-import.service.js';
import { EmployeesService } from './employees.service.js';

const MAX_CSV_BYTES = 2 * 1024 * 1024;

interface UploadedCsv {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

@ApiTags('Employees')
@ApiBearerAuth()
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly importer: EmployeeImportService,
  ) {}

  @Post()
  @Roles('HR')
  @ApiOperation({ summary: 'Register an employee (HR) — auto-creates a login with a temporary password' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateEmployeeDto) {
    return this.employees.create(user, dto);
  }

  @Get()
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Search (q), filter (departmentId, designationId, status) and paginate (page, limit)' })
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListEmployeesQueryDto) {
    return this.employees.findAll(user, query);
  }

  @Get('export')
  @Roles('HR')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Export employees as CSV (same filters as the list)' })
  async exportCsv(@CurrentUser() user: AuthUser, @Query() query: ExportEmployeesQueryDto): Promise<StreamableFile> {
    const csv = await this.employees.exportCsv(user, query);
    return new StreamableFile(Buffer.from(csv, 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: `attachment; filename="employees-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
  }

  @Get('import/template')
  @Roles('HR')
  @ApiProduces('text/csv')
  @ApiOperation({ summary: 'Download the CSV import template (header row)' })
  template(): StreamableFile {
    return new StreamableFile(Buffer.from(this.importer.templateCsv(), 'utf8'), {
      type: 'text/csv; charset=utf-8',
      disposition: 'attachment; filename="employee-import-template.csv"',
    });
  }

  @Post('import')
  @Roles('HR')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_CSV_BYTES, files: 1 } }))
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary', description: 'CSV file' },
        csv: { type: 'string', description: 'or raw CSV text' },
      },
    },
  })
  @ApiOperation({
    summary: 'CSV import with dry-run validation → { valid, errors: [{ row, field, reason }] }',
    description:
      'dryRun=true (default) only validates. dryRun=false inserts ONLY if every row is valid (otherwise 422 with the same body). ' +
      'Columns: code, fullName, email, phone, address, gender, department, designation, joinDate, status, exitDate, basicSalary.',
  })
  async import(
    @CurrentUser() user: AuthUser,
    @Query() query: ImportEmployeesQueryDto,
    @Body() body: ImportEmployeesBodyDto,
    @UploadedFile() file?: UploadedCsv,
  ) {
    let content: Buffer | string;
    if (file) {
      const looksLikeCsv =
        /\.csv$/i.test(file.originalname) ||
        /csv|text\/plain|application\/vnd\.ms-excel|application\/octet-stream/i.test(file.mimetype);
      if (!looksLikeCsv) throw new BadRequestException('Please upload a .csv file');
      content = file.buffer;
    } else if (body?.csv) {
      content = body.csv;
    } else {
      throw new BadRequestException('Upload a CSV file in the "file" field (multipart/form-data) or send { "csv": "..." }');
    }

    const dryRun = query.dryRun ?? true;
    const result = await this.importer.import(user, content, dryRun);
    if (!dryRun && !result.valid) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: 'Import aborted — fix the listed rows and try again. No records were inserted.',
        ...result,
      });
    }
    return result;
  }

  @Get('me')
  @ApiOperation({ summary: 'My own 360 profile' })
  me(@CurrentUser() user: AuthUser) {
    return this.employees.profile(user, requireEmployeeId(user));
  }

  @Patch('me')
  @ApiOperation({ summary: 'Edit ONLY my own phone and address (any other field → 400)' })
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMyProfileDto) {
    return this.employees.updateMyProfile(user, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Employee 360 profile (Admin/HR: anyone; Employee: own id only → else 403)' })
  profile(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.employees.profile(user, id);
  }

  @Patch(':id')
  @Roles('HR')
  @ApiOperation({ summary: 'Update job details / status / salary (HR) — exiting deactivates the login' })
  update(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdateEmployeeDto) {
    return this.employees.update(user, id, dto);
  }
}
