import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ForbiddenException, HttpException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import * as z from 'zod/v4';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { ISO_DATE_REGEX, monthBounds, MONTH_REGEX } from '../../common/utils/date.util.js';
import { DashboardService } from '../dashboard/dashboard.service.js';
import { EmployeesService } from '../employees/employees.service.js';
import { EMPLOYEE_STATUSES } from '../employees/schemas/employee.schema.js';
import { LeaveService } from '../leave/leave.service.js';
import { PayrollService } from '../payroll/payroll.service.js';
import { DepartmentsService } from '../setup/departments.service.js';
import type { AiToolCall } from './schemas/ai-log.schema.js';

const isoDate = z.string().regex(ISO_DATE_REGEX).describe('Date in YYYY-MM-DD format');
const isoMonth = z.string().regex(MONTH_REGEX).describe('Month in YYYY-MM format');
const departmentParam = z
  .string()
  .min(1)
  .max(100)
  .describe('Department name or code (omit for all departments)');

const ACCESS_DENIED_INSTRUCTION =
  "Politely decline in the user's language; explain they can only access their own records. Do not guess the data.";

/**
 * The 7 assistant tools. Each one calls the SAME NestJS service methods as the REST API,
 * passing the current user, so role and employee data-scope rules are enforced exactly as
 * on the dashboards (and the numbers match them). Tools are read-only.
 */
@Injectable()
export class AiToolsService {
  private readonly logger = new Logger(AiToolsService.name);

  constructor(
    private readonly dashboard: DashboardService,
    private readonly employees: EmployeesService,
    private readonly leave: LeaveService,
    private readonly payroll: PayrollService,
    private readonly departments: DepartmentsService,
  ) {}

  build(user: AuthUser, calls: AiToolCall[]) {
    const execute = async (name: string, input: unknown, fn: () => Promise<unknown>): Promise<string> => {
      try {
        const result = await fn();
        calls.push({ name, input, status: 'ok' });
        return JSON.stringify(result);
      } catch (error) {
        if (error instanceof ForbiddenException) {
          calls.push({ name, input, status: 'denied', error: error.message });
          return JSON.stringify({ error: 'ACCESS_DENIED', message: error.message, instruction: ACCESS_DENIED_INSTRUCTION });
        }
        if (error instanceof HttpException) {
          calls.push({ name, input, status: 'error', error: error.message });
          return JSON.stringify({ error: 'REQUEST_FAILED', status: error.getStatus(), message: error.message });
        }
        this.logger.error(`Tool ${name} failed: ${(error as Error).message}`, (error as Error).stack);
        calls.push({ name, input, status: 'error', error: 'internal error' });
        return JSON.stringify({ error: 'TOOL_FAILED', message: 'The data could not be loaded right now.' });
      }
    };

    const departmentId = async (ref?: string): Promise<string | undefined> => {
      if (!ref) return undefined;
      const department = await this.departments.resolve(ref);
      if (!department) {
        const known = (await this.departments.findAll()).map((d) => d.name).join(', ') || 'none configured';
        throw new UnprocessableEntityException(`Unknown department "${ref}". Known departments: ${known}`);
      }
      return String(department._id);
    };

    const employeeId = async (ref?: string): Promise<string | undefined> => {
      if (!ref) return undefined;
      const employee = await this.employees.resolveReference(ref);
      if (!employee) throw new UnprocessableEntityException(`No single employee matches "${ref}". Use search_employees first.`);
      return String(employee._id);
    };

    return [
      betaZodTool({
        name: 'get_headcount',
        description:
          'Number of employees (active + probation) employed on a date, overall and per department. ' +
          'Call this for questions about headcount, staff strength or "how many employees". Admin/HR only.',
        inputSchema: z.object({
          department: departmentParam.optional(),
          date: isoDate.optional().describe('Date to count on (default: today)'),
        }),
        run: (input) =>
          execute('get_headcount', input, async () =>
            this.dashboard.getHeadcount(user, { endDate: input.date, departmentId: await departmentId(input.department) }),
          ),
      }),

      betaZodTool({
        name: 'get_attendance_summary',
        description:
          'Attendance KPIs for a date range: counts per status (present, late, half_day, missing_checkout, absent, on_leave), ' +
          'attendance rate %, late % and absenteeism %. Call this for attendance, presence or absence questions. ' +
          "For an Employee it returns only their own attendance.",
        inputSchema: z.object({
          startDate: isoDate.optional().describe('Start date (default: first day of the current month)'),
          endDate: isoDate.optional().describe('End date (default: today)'),
          department: departmentParam.optional(),
        }),
        run: (input) =>
          execute('get_attendance_summary', input, async () =>
            this.dashboard.getAttendanceSummary(user, {
              startDate: input.startDate,
              endDate: input.endDate,
              departmentId: await departmentId(input.department),
            }),
          ),
      }),

      betaZodTool({
        name: 'get_late_comers',
        description:
          'Employees ranked by number of late arrivals in a date range, with average minutes late. ' +
          'Call this for "who came late", "late comers" or punctuality questions. An Employee only sees themselves.',
        inputSchema: z.object({
          startDate: isoDate.optional(),
          endDate: isoDate.optional(),
          department: departmentParam.optional(),
          limit: z.number().int().min(1).max(20).optional().describe('How many people to list (default 10)'),
        }),
        run: (input) =>
          execute('get_late_comers', input, async () =>
            this.dashboard.getLateComers(user, {
              startDate: input.startDate,
              endDate: input.endDate,
              departmentId: await departmentId(input.department),
              limit: input.limit ?? 10,
            }),
          ),
      }),

      betaZodTool({
        name: 'get_leave_summary',
        description:
          'Leave for a date range: requests by status (pending/approved/rejected/cancelled), WHO is on approved leave ' +
          '(onLeave list + onLeaveByType counts) and approved days vs quota (utilization %) per leave type and department. ' +
          'Call this for "who is on leave today" (startDate = endDate = today), leave trends, pending approvals or utilization. ' +
          'An Employee only sees their own leave.',
        inputSchema: z.object({
          startDate: isoDate.optional(),
          endDate: isoDate.optional(),
          department: departmentParam.optional(),
        }),
        run: (input) =>
          execute('get_leave_summary', input, async () =>
            this.dashboard.getLeaveSummary(user, {
              startDate: input.startDate,
              endDate: input.endDate,
              departmentId: await departmentId(input.department),
            }),
          ),
      }),

      betaZodTool({
        name: 'get_my_leave_balance',
        description:
          "The current user's OWN leave balance per leave type for a year: quota, used (approved), pending and remaining days. " +
          'Call this when the user asks how many leaves they have left / "meri kitni chuttiyan baqi hain".',
        inputSchema: z.object({
          year: z.number().int().min(2000).max(2100).optional().describe('Calendar year (default: current year)'),
        }),
        run: (input) =>
          execute('get_my_leave_balance', input, () => this.leave.getBalances(user, { year: input.year })),
      }),

      betaZodTool({
        name: 'get_payroll_summary',
        description:
          'Payroll figures for a month range. Admin/HR: gross, net, tax and deductions by month and department plus average ' +
          'gross salary by department/designation (optionally for one employee). Employee: only their own finalized payslips. ' +
          'Call this for salary cost, payroll totals, average salary or "my salary/payslip" questions.',
        inputSchema: z.object({
          startMonth: isoMonth.optional().describe('First month (default: current month)'),
          endMonth: isoMonth.optional().describe('Last month (default: same as startMonth or current month)'),
          department: departmentParam.optional(),
          employee: z
            .string()
            .min(1)
            .max(120)
            .optional()
            .describe('Admin/HR only: employee code, email or exact full name to drill into'),
        }),
        run: (input) =>
          execute('get_payroll_summary', input, async () => {
            const startMonth = input.startMonth ?? input.endMonth;
            const endMonth = input.endMonth ?? input.startMonth;
            return this.payroll.getPayrollSummary(user, {
              startDate: startMonth ? `${startMonth}-01` : undefined,
              endDate: endMonth ? monthBounds(endMonth).end : undefined,
              departmentId: await departmentId(input.department),
              employeeId: await employeeId(input.employee),
            });
          }),
      }),

      betaZodTool({
        name: 'search_employees',
        description:
          'Search the employee directory by name, code, email or phone, optionally filtered by department and status. ' +
          'Returns job details and salary structure. Call this to find a person or list people in a department. ' +
          'Employees may only look themselves up; any other lookup returns ACCESS_DENIED.',
        inputSchema: z.object({
          query: z.string().max(100).optional().describe('Name, code, email or phone fragment'),
          department: departmentParam.optional(),
          status: z.enum(EMPLOYEE_STATUSES).optional(),
          limit: z.number().int().min(1).max(25).optional(),
        }),
        run: (input) =>
          execute('search_employees', input, () =>
            this.employees.searchForAssistant(user, {
              query: input.query,
              department: input.department,
              status: input.status,
              limit: input.limit,
            }),
          ),
      }),
    ];
  }
}
