import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Readable } from 'node:stream';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { Roles } from '../../common/decorators/roles.decorator.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { ParseObjectIdPipe } from '../../common/pipes/parse-object-id.pipe.js';
import { requireEmployeeId } from '../../common/utils/scope.util.js';
import { SettingsService } from '../setup/settings.service.js';
import {
  CreatePayrollRunDto,
  PayrollRunQueryDto,
  PayslipQueryDto,
  SalaryCalculatorQueryDto,
  UpdatePayrollRunDto,
} from './dto/payroll.dto.js';
import { PayrollService } from './payroll.service.js';
import { PayslipPdfService } from './payslip-pdf.service.js';

@ApiTags('Payroll')
@ApiBearerAuth()
@Controller('payroll')
export class PayrollController {
  constructor(
    private readonly payroll: PayrollService,
    private readonly pdf: PayslipPdfService,
    private readonly settings: SettingsService,
  ) {}

  // ── Runs (HR creates/updates drafts; only Admin finalizes) ──
  @Post('runs')
  @Roles('HR')
  @ApiOperation({ summary: 'Create the monthly draft run + payslips (HR; Admin views, then finalizes)' })
  createRun(@CurrentUser() user: AuthUser, @Body() dto: CreatePayrollRunDto) {
    return this.payroll.createRun(user, dto);
  }

  @Get('runs')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'List payroll runs (HR/Admin)' })
  listRuns(@Query() query: PayrollRunQueryDto) {
    return this.payroll.listRuns(query);
  }

  @Get('runs/:id')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Payroll run with its payslips (HR/Admin)' })
  getRun(@Param('id', ParseObjectIdPipe) id: string) {
    return this.payroll.getRun(id);
  }

  @Patch('runs/:id')
  @Roles('HR')
  @ApiOperation({ summary: 'Update draft notes (403 once finalized)' })
  updateRun(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string, @Body() dto: UpdatePayrollRunDto) {
    return this.payroll.update(user, id, dto);
  }

  @Post('runs/:id/recalculate')
  @HttpCode(HttpStatus.OK)
  @Roles('HR')
  @ApiOperation({ summary: 'Recalculate a draft from current data (403 once finalized)' })
  recalculate(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.payroll.recalculate(user, id);
  }

  @Delete('runs/:id')
  @Roles('HR')
  @ApiOperation({ summary: 'Delete a draft run (403 once finalized)' })
  removeRun(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.payroll.remove(user, id);
  }

  @Post('runs/:id/finalize')
  @HttpCode(HttpStatus.OK)
  @Roles('Admin')
  @ApiOperation({ summary: 'Finalize & lock a run (Admin only) — employees are notified' })
  finalize(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.payroll.finalize(user, id);
  }

  @Get('calculator')
  @Roles('Admin', 'HR')
  @ApiOperation({ summary: 'Salary structure & tax for a basic salary (what-if helper)' })
  calculator(@Query() query: SalaryCalculatorQueryDto) {
    return this.payroll.calculator(query.basic);
  }

  // ── Payslips ───────────────────────────────────────
  @Get('payslips')
  @ApiOperation({ summary: 'Payslips (Admin/HR: all incl. drafts; Employee: own finalized only)' })
  listPayslips(@CurrentUser() user: AuthUser, @Query() query: PayslipQueryDto) {
    return this.payroll.listPayslips(user, query);
  }

  @Get('payslips/me')
  @ApiOperation({ summary: 'My payslips (finalized)' })
  myPayslips(@CurrentUser() user: AuthUser, @Query() query: PayslipQueryDto) {
    return this.payroll.listPayslips(user, { ...query, employeeId: requireEmployeeId(user) });
  }

  @Get('payslips/:id')
  @ApiOperation({ summary: 'One payslip (Employee: own finalized only)' })
  getPayslip(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string) {
    return this.payroll.getPayslip(user, id);
  }

  @Get('payslips/:id/pdf')
  @ApiProduces('application/pdf')
  @ApiOperation({ summary: 'Stream the payslip as a PDF (Employee: own finalized only)' })
  async payslipPdf(@CurrentUser() user: AuthUser, @Param('id', ParseObjectIdPipe) id: string): Promise<StreamableFile> {
    const payslip = await this.payroll.getPayslipDocument(user, id);
    const settings = await this.settings.get();
    const document = this.pdf.render(payslip, settings.companyName, settings.timezone);
    const filename = `payslip-${payslip.employee.code}-${payslip.month}.pdf`;
    return new StreamableFile(document as unknown as Readable, {
      type: 'application/pdf',
      disposition: `inline; filename="${filename}"`,
    });
  }
}
