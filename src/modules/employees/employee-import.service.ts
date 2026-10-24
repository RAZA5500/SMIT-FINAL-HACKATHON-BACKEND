import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isEmail } from 'class-validator';
import { parse } from 'csv-parse/sync';
import { Model, Types } from 'mongoose';
import { Role } from '../../common/constants/roles.js';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { isValidIsoDate } from '../../common/utils/date.util.js';
import { generateTempPassword } from '../../common/utils/password.util.js';
import { AuditService } from '../audit/audit.service.js';
import { User, type UserDocument } from '../auth/schemas/user.schema.js';
import { UsersService } from '../auth/users.service.js';
import type { DepartmentDocument } from '../setup/schemas/department.schema.js';
import type { DesignationDocument } from '../setup/schemas/designation.schema.js';
import { DepartmentsService } from '../setup/departments.service.js';
import { DesignationsService } from '../setup/designations.service.js';
import { EMPLOYEE_CODE_REGEX, PHONE_REGEX } from './dto/employee.dto.js';
import {
  Employee,
  EMPLOYEE_STATUSES,
  GENDERS,
  type EmployeeDocument,
  type EmployeeStatus,
  type Gender,
} from './schemas/employee.schema.js';

export const IMPORT_FIELDS = [
  'code',
  'fullName',
  'email',
  'phone',
  'address',
  'gender',
  'department',
  'designation',
  'joinDate',
  'status',
  'exitDate',
  'basicSalary',
] as const;
type ImportField = (typeof IMPORT_FIELDS)[number];

const REQUIRED_FIELDS: ImportField[] = ['code', 'fullName', 'email', 'department', 'designation', 'joinDate', 'basicSalary'];
export const MAX_IMPORT_ROWS = 1000;

/** Accepted header spellings (case/space/underscore-insensitive). */
const HEADER_ALIASES: Record<string, ImportField> = {
  code: 'code',
  employeecode: 'code',
  empcode: 'code',
  fullname: 'fullName',
  name: 'fullName',
  employeename: 'fullName',
  email: 'email',
  emailaddress: 'email',
  phone: 'phone',
  phonenumber: 'phone',
  mobile: 'phone',
  address: 'address',
  gender: 'gender',
  department: 'department',
  departmentname: 'department',
  departmentcode: 'department',
  departmentid: 'department',
  designation: 'designation',
  designationname: 'designation',
  designationid: 'designation',
  jobtitle: 'designation',
  joindate: 'joinDate',
  joiningdate: 'joinDate',
  dateofjoining: 'joinDate',
  status: 'status',
  exitdate: 'exitDate',
  basicsalary: 'basicSalary',
  basic: 'basicSalary',
  salary: 'basicSalary',
};

export interface ImportError {
  /** Line number in the file (the header is line 1). */
  row: number;
  field: string;
  reason: string;
}

export interface ImportResult {
  valid: boolean;
  dryRun: boolean;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  inserted: number;
  errors: ImportError[];
  credentials?: { code: string; fullName: string; email: string; temporaryPassword: string }[];
}

interface ParsedRow {
  row: number;
  values: Partial<Record<ImportField, string>>;
}

interface PreparedEmployee {
  _id: Types.ObjectId;
  code: string;
  fullName: string;
  email: string;
  phone: string;
  address: string;
  gender: Gender | null;
  departmentId: Types.ObjectId;
  designationId: Types.ObjectId;
  joinDate: string;
  status: EmployeeStatus;
  exitDate: string | null;
  basicSalary: number;
}

const normalizeHeader = (header: string) => header.trim().toLowerCase().replace(/[\s_\-.]/g, '');

/**
 * CSV employee import with full dry-run validation. Every row is checked for required
 * fields, unique code/email (against the DB and within the file), email format, known
 * department/designation, ISO dates and basicSalary > 0. Records are inserted only when
 * `dryRun=false` AND every row is valid — all or nothing.
 */
@Injectable()
export class EmployeeImportService {
  constructor(
    @InjectModel(Employee.name) private readonly employeeModel: Model<EmployeeDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly departments: DepartmentsService,
    private readonly designations: DesignationsService,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  templateCsv(): string {
    return `${IMPORT_FIELDS.join(',')}\n`;
  }

  async import(actor: AuthUser, content: Buffer | string, dryRun: boolean): Promise<ImportResult> {
    const result = (errors: ImportError[], totalRows = 0, invalidRows = totalRows): ImportResult => ({
      valid: false,
      dryRun,
      totalRows,
      validRows: totalRows - invalidRows,
      invalidRows,
      inserted: 0,
      errors,
    });

    let records: { record: string[]; info: { lines: number } }[];
    try {
      records = parse(content, {
        bom: true,
        trim: true,
        skip_empty_lines: true,
        relax_column_count: true,
        info: true,
      }) as unknown as { record: string[]; info: { lines: number } }[];
    } catch (error) {
      return result([{ row: 0, field: 'file', reason: `The file is not valid CSV: ${(error as Error).message}` }]);
    }
    if (records.length === 0) return result([{ row: 1, field: 'file', reason: 'The CSV file is empty' }]);

    // ── Header ────────────────────────────────────────
    const headerFields = records[0].record.map((h) => HEADER_ALIASES[normalizeHeader(h)] ?? null);
    const missingColumns = REQUIRED_FIELDS.filter((f) => !headerFields.includes(f));
    if (missingColumns.length) {
      return result(missingColumns.map((field) => ({ row: 1, field, reason: 'Required column is missing from the header' })));
    }
    const dataRecords = records.slice(1);
    if (dataRecords.length === 0) return result([{ row: 2, field: 'file', reason: 'The CSV has no data rows' }]);
    if (dataRecords.length > MAX_IMPORT_ROWS) {
      return result(
        [{ row: 0, field: 'file', reason: `Too many rows (${dataRecords.length}); the maximum per import is ${MAX_IMPORT_ROWS}` }],
        dataRecords.length,
      );
    }

    const rows: ParsedRow[] = dataRecords.map(({ record, info }) => {
      const values: Partial<Record<ImportField, string>> = {};
      headerFields.forEach((field, index) => {
        if (field && values[field] === undefined) values[field] = (record[index] ?? '').trim();
      });
      return { row: info.lines, values };
    });

    // ── Reference data & existing uniques (one query each) ──
    const codes = rows.map((r) => (r.values.code ?? '').toUpperCase()).filter(Boolean);
    const emails = rows.map((r) => (r.values.email ?? '').toLowerCase()).filter(Boolean);
    const [departments, designations, existingEmployees, existingUsers] = await Promise.all([
      this.departments.findAllDocuments(),
      this.designations.findAllDocuments(),
      this.employeeModel
        .find({ $or: [{ code: { $in: codes } }, { email: { $in: emails } }] }, { code: 1, email: 1 })
        .lean()
        .exec(),
      this.userModel.find({ email: { $in: emails } }, { email: 1 }).lean().exec(),
    ]);
    const existingCodes = new Set(existingEmployees.map((e) => e.code));
    const existingEmails = new Set([...existingEmployees.map((e) => e.email), ...existingUsers.map((u) => u.email)]);

    // ── Row validation ─────────────────────────────────
    const errors: ImportError[] = [];
    const seenCodes = new Map<string, number>();
    const seenEmails = new Map<string, number>();
    const prepared: PreparedEmployee[] = [];
    const invalidRowNumbers = new Set<number>();

    for (const { row, values } of rows) {
      const rowErrors: ImportError[] = [];
      const fail = (field: string, reason: string) => rowErrors.push({ row, field, reason });

      for (const field of REQUIRED_FIELDS) {
        if (!values[field]) fail(field, 'Required field is missing');
      }

      const code = (values.code ?? '').toUpperCase();
      if (code) {
        if (!EMPLOYEE_CODE_REGEX.test(code)) fail('code', 'Code may only contain letters, digits, - or _ (max 20)');
        else if (seenCodes.has(code)) fail('code', `Duplicate code in CSV (first seen on row ${seenCodes.get(code)})`);
        else if (existingCodes.has(code)) fail('code', `Code ${code} already exists`);
        if (!seenCodes.has(code)) seenCodes.set(code, row);
      }

      const email = (values.email ?? '').toLowerCase();
      if (email) {
        if (!isEmail(email)) fail('email', 'Invalid email format');
        else if (seenEmails.has(email)) fail('email', `Duplicate email in CSV (first seen on row ${seenEmails.get(email)})`);
        else if (existingEmails.has(email)) fail('email', `Email ${email} already exists`);
        if (!seenEmails.has(email)) seenEmails.set(email, row);
      }

      if (values.fullName && values.fullName.length > 120) fail('fullName', 'fullName must be at most 120 characters');

      const department = values.department ? findByRef(departments, values.department, true) : null;
      if (values.department) {
        if (!department) fail('department', `Unknown department "${values.department}"`);
        else if (!department.isActive) fail('department', `Department "${department.name}" is inactive`);
      }
      const designation = values.designation ? findByRef(designations, values.designation, false) : null;
      if (values.designation) {
        if (!designation) fail('designation', `Unknown designation "${values.designation}"`);
        else if (!designation.isActive) fail('designation', `Designation "${designation.name}" is inactive`);
      }

      if (values.joinDate && !isValidIsoDate(values.joinDate)) {
        fail('joinDate', `Invalid date "${values.joinDate}" — expected YYYY-MM-DD`);
      }
      const exitDate = values.exitDate || null;
      if (exitDate && !isValidIsoDate(exitDate)) fail('exitDate', `Invalid date "${exitDate}" — expected YYYY-MM-DD`);
      else if (exitDate && values.joinDate && isValidIsoDate(values.joinDate) && exitDate < values.joinDate) {
        fail('exitDate', 'exitDate cannot be before joinDate');
      }

      let basicSalary = NaN;
      if (values.basicSalary) {
        basicSalary = Number(values.basicSalary.replace(/,/g, ''));
        if (!Number.isFinite(basicSalary) || basicSalary <= 0) fail('basicSalary', 'basicSalary must be a number greater than 0');
      }

      const gender = values.gender ? values.gender.toLowerCase() : '';
      if (gender && !(GENDERS as readonly string[]).includes(gender)) {
        fail('gender', `gender must be one of: ${GENDERS.join(', ')}`);
      }
      const status = values.status ? values.status.toLowerCase() : 'active';
      if (!(EMPLOYEE_STATUSES as readonly string[]).includes(status)) {
        fail('status', `status must be one of: ${EMPLOYEE_STATUSES.join(', ')}`);
      } else if (status === 'exited' && !exitDate) {
        fail('exitDate', 'exitDate is required when status is "exited"');
      }
      if (values.phone && !PHONE_REGEX.test(values.phone)) fail('phone', 'phone must be a valid phone number');
      if (values.address && values.address.length > 300) fail('address', 'address must be at most 300 characters');

      if (rowErrors.length) {
        errors.push(...rowErrors);
        invalidRowNumbers.add(row);
        continue;
      }
      prepared.push({
        _id: new Types.ObjectId(),
        code,
        fullName: values.fullName!,
        email,
        phone: values.phone ?? '',
        address: values.address ?? '',
        gender: (gender || null) as Gender | null,
        departmentId: department!._id,
        designationId: designation!._id,
        joinDate: values.joinDate!,
        status: status as EmployeeStatus,
        exitDate,
        basicSalary,
      });
    }

    const summary: ImportResult = {
      valid: errors.length === 0,
      dryRun,
      totalRows: rows.length,
      validRows: rows.length - invalidRowNumbers.size,
      invalidRows: invalidRowNumbers.size,
      inserted: 0,
      errors,
    };
    if (dryRun || !summary.valid) return summary;

    // ── Commit (all rows valid) ─────────────────────────
    const credentials = await this.insertAll(actor, prepared);
    return { ...summary, inserted: prepared.length, credentials };
  }

  private async insertAll(actor: AuthUser, prepared: PreparedEmployee[]): Promise<NonNullable<ImportResult['credentials']>> {
    const passwords = prepared.map(() => generateTempPassword());
    const hashes = await Promise.all(passwords.map((p) => this.users.hashPassword(p)));
    const userIds = prepared.map(() => new Types.ObjectId());
    const employeeIds = prepared.map((p) => p._id);

    try {
      await this.employeeModel.insertMany(
        prepared.map((p, i) => ({ ...p, userId: userIds[i], createdBy: actor.userId })),
        { ordered: true },
      );
      await this.userModel.insertMany(
        prepared.map((p, i) => ({
          _id: userIds[i],
          email: p.email,
          fullName: p.fullName,
          role: Role.Employee,
          employeeId: p._id,
          passwordHash: hashes[i],
          mustChangePassword: true,
          isActive: p.status !== 'exited',
          createdBy: actor.userId,
        })),
        { ordered: true },
      );
    } catch (error) {
      // All-or-nothing: remove anything this import managed to write.
      await this.userModel.deleteMany({ _id: { $in: userIds } }).exec();
      await this.employeeModel.deleteMany({ _id: { $in: employeeIds } }).exec();
      throw error;
    }

    await this.audit.record({
      actor,
      action: 'import',
      entity: 'Employee',
      entityId: null,
      after: { count: prepared.length, employees: prepared.map((p) => ({ id: String(p._id), code: p.code, email: p.email })) },
    });

    return prepared.map((p, i) => ({
      code: p.code,
      fullName: p.fullName,
      email: p.email,
      temporaryPassword: passwords[i],
    }));
  }
}

function findByRef<T extends DepartmentDocument | DesignationDocument>(items: T[], ref: string, matchCode: boolean): T | null {
  const value = ref.trim().toLowerCase();
  return (
    items.find((item) => String(item._id) === ref.trim()) ??
    items.find((item) => item.name.toLowerCase() === value) ??
    (matchCode ? items.find((item) => (item as DepartmentDocument).code?.toLowerCase() === value) : undefined) ??
    null
  );
}
