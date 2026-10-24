# Role & Objective
You are a Principal NestJS Backend Architect. Build the complete, secure, production-ready modular REST API in **NestJS (TypeScript)** for **"HCM Lite" — an AI-assisted Human Capital Management System** serving `Admin`, `HR`, and `Employee` roles.

## 1. Critical Hackathon Rule: Zero Seed/Dummy Data & First-Run Flow
- Do NOT seed dummy employees, fake attendance rows, or mock payroll runs. The database must start completely empty.
- **First-Run Setup**:
  - Expose `GET /api/setup/status` returning `{ initialized: boolean }` (checks if any Admin user / CompanySettings record exists).
  - Expose `POST /api/setup/init` allowing the first visitor (or startup hook reading `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `.env` if provided) to create the Company Settings and the first `Admin` account.

## 2. NestJS Architecture & Tech Stack
- **Framework**: NestJS with strict modular separation:
  - `src/modules/auth` (M1)
  - `src/modules/setup` (M2)
  - `src/modules/employees` (M3)
  - `src/modules/attendance` (M4)
  - `src/modules/leave` (M5)
  - `src/modules/payroll` (M6)
  - `src/modules/dashboard` (M7)
  - `src/modules/ai` (M8)
  - `src/modules/comms` & `src/modules/audit` (M9)
- **Database & ORM**: PostgreSQL with **Prisma ORM** (or MongoDB with `@nestjs/mongoose`).
- **Validation & Security**:
  - Global `ValidationPipe` (`class-validator`, `class-transformer`).
  - `@nestjs/jwt` + `@nestjs/passport` + `bcrypt` for password hashing.
  - Custom `JwtAuthGuard`, `RolesGuard` (`@Roles('Admin', 'HR', 'Employee')`), and `@CurrentUser()` param decorator.
  - **Data-Scope Enforcement**: Every service method called by an `Employee` MUST scope queries strictly to `employeeId: user.employeeId`. An `Employee` can NEVER read another employee's profile, salary, attendance, leave, or payslip.
- **Libraries**:
  - `geolib` (`isPointWithinRadius` for Haversine office geofence calculation).
  - `pdfkit` (server-side Payslip PDF streaming).
  - `csv-parse` & `json2csv` (employee CSV dry-run validation & export).
  - `@nestjs/throttler` (rate limiting AI endpoints to ~20 requests per user per hour).

---

## 3. Exact Business Rules by NestJS Module (Enforce in Services)

### M1: `AuthModule`
- JWT login (`POST /api/auth/login`), password change (`POST /api/auth/change-password`).
- When `HR` registers an employee, auto-create their User login with a hashed temporary password and `mustChangePassword: true`.
- `Admin` can create `HR` logins, and deactivate or reset passwords for any `HR` or `Employee` login.

### M2: `SetupModule` (Organization Setup)
- `CompanySettings`: `companyName`, `officeStartTime` (`"09:00"`), `graceMinutes` (`15`), `halfDayThresholdHours` (`5`), `weekendDays` (`["Saturday", "Sunday"]`), `officeLocation` (`lat`, `lng`, `radiusMeters: 150`), and bonus `latePenaltyRuleEnabled` (`3 lates = 0.5 day`).
- Rule changes apply to **new records only** (store rule snapshots on attendance/payroll records).
- CRUD for `Departments`, `Designations`, `LeaveTypes` (defaults: `Annual: 14`, `Sick: 8`, `Casual: 10`, `Unpaid: unlimited`), and `PublicHolidays`.
- Permissions: `Admin` = Manage; `HR` = View; `Employee` = View own relevant policies/holidays.

### M3: `EmployeesModule`
- `HR` registers employees with job details (`code`, `fullName`, `email`, `phone`, `address`, `gender`, `departmentId`, `designationId`, `joinDate`, `status: 'active' | 'probation' | 'exited'`, `exitDate`) and salary structure (`basicSalary`).
- `GET /api/employees`: Server-side search (`q`), filters (`departmentId`, `designationId`, `status`), and pagination (`page`, `limit`).
- `GET /api/employees/:id`: Employee 360 profile (`Admin`/`HR` = all; `Employee` = own `employeeId` only).
- `PATCH /api/employees/me`: `Employee` can edit ONLY own `phone` and `address`.
- **CSV Import (`POST /api/employees/import?dryRun=true|false`)**:
  - Validates every row for: required fields, unique `code` and `email` (against DB and within CSV), valid email format, known department, valid ISO date (`YYYY-MM-DD`), and `basicSalary > 0`.
  - Returns `{ valid: boolean, errors: [{ row: number, field: string, reason: string }] }`. Inserts records only when `dryRun=false` and all rows are valid.

### M4: `AttendanceModule` & Camera Geofence Verification
- **Server stamps the time** (never trust client time).
- **One record per employee per day**: A second check-in on the same day MUST throw `ConflictException` (**`HTTP 409`**).
- **Status Calculation**:
  - Check-in after `09:15` (`officeStartTime + graceMinutes`) -> `late`; otherwise `present`.
  - On Check-out: if worked hours `< 5` -> `half_day`.
  - If checked in with no check-out -> `missing_checkout`.
  - If working day has no record and no approved leave -> `absent`.
- **Camera Check-In (`source: 'camera'`)**:
  - Reject if `faceDetected !== true` or `faceCount !== 1`.
  - Reject if GPS `accuracy > 100` meters.
  - Compute distance to Admin's `officeLocation` using Haversine formula (`geolib.isPointWithinRadius`). Reject if outside `radiusMeters`.
  - Store verification result (`source: 'camera'`, `distanceMeters`, `gpsAccuracy`), not raw photos.
- **Corrections**: `Employee` requests correction with `reason`; `HR` approves or rejects (updates record and writes to `AuditService`).

### M5: `LeaveModule`
- Calculate working days by skipping configured `weekendDays` (`Sat-Sun`) and `PublicHolidays`.
- Quotas: `Annual = 14`, `Sick = 8`, `Casual = 10`, `Unpaid = unlimited`.
- **Strict Validation (`UnprocessableEntityException` — `HTTP 422`)**:
  - Throw **`422`** if requested dates overlap with an existing pending/approved leave for that employee.
  - Throw **`422`** if requested working days exceed remaining quota balance.
- `HR` approves or rejects with a `comment` -> triggers notification and audit log entry.

### M6: `PayrollModule` & Payslip PDF
- **Salary Structure**:
  - `basic` = set by HR
  - `hra` = `0.40 * basic` (40%)
  - `medical` = `0.10 * basic` (10%)
  - `gross` = `1.5 * basic` (`basic + hra + medical`)
- **Monthly Payroll Calculation**:
  - `perDay = gross / workingDaysInMonth`
  - Prorate for joiners/leavers within the month.
  - `deductionDays = absentDays + unpaidLeaveDays + (0.5 * halfDays)` (+ bonus `Math.floor(lates / 3) * 0.5` if enabled).
  - `attendanceDeduction = deductionDays * perDay`.
- **Annualized Tax Slab Formula (on `annualGross = gross * 12`)**:
  - `0` to `600,000`: `0`
  - `600,001` to `1,200,000`: `5%` of amount above `600,000`
  - `1,200,001` to `2,400,000`: `30,000 + 15%` of amount above `1,200,000`
  - `2,400,001` to `3,600,000`: `210,000 + 25%` of amount above `2,400,000`
  - Above `3,600,000`: `510,000 + 35%` of amount above `3,600,000`
  - `monthlyTax = annualTax / 12`
  - `netPay = proratedGross - attendanceDeduction - monthlyTax`
- **Draft vs Finalize Lock**:
  - `HR` creates/updates monthly draft (`status: 'draft'`).
  - Only `Admin` can call `POST /api/payroll/runs/:id/finalize` (`status: 'finalized'`).
  - Once finalized, throw `ForbiddenException` (`403`) on any edit attempt.
- **Payslip PDF (`GET /api/payroll/payslips/:id/pdf`)**: Stream a clean PDF via `pdfkit`.

### M7: `DashboardModule` (Server-Side Aggregations)
Compute all numbers via DB aggregations filtered by `startDate`, `endDate`, and `departmentId`:
- **Headcount**: `active + probation` on end date.
- **Attrition**: `(exits in period / average headcount) * 100`.
- **Attendance Rate**: `(present + late + missing_checkout + 0.5 * half_day) / (working_day_records - on_leave)`.
- **Late %**: `late / (present + late)`.
- **Absenteeism**: `absent_days / expected_working_days`, per department.
- **Leave Utilization**: `approved_days / quota`, per leave type and department.
- **Payroll Cost / Avg Salary**: Sum of `gross` and `net` by month and department; mean `gross` by department and designation.
- **Bonus Metrics**: Compute per-employee **Attrition Risk Score** and **Absence Anomaly Flags**.

### M8: `AiModule` (LLM Tool Calling & Guardrails)
- **Guardrails**:
  - Read `process.env.AI_API_KEY` on server only.
  - Rate-limit to **20 requests per user per hour** (`@Throttle`).
  - Enforce a **15-second timeout** (`RxJS timeout(15000)` or `AbortSignal.timeout(15000)`) with a friendly fallback response.
  - Log every call in `ai_logs` (`userId`, `role`, `feature`, `prompt`, `toolsCalled`, `response`, `status`, `latencyMs`).
  - Every response includes `aiGenerated: true`.
  - AI NEVER queries the database directly and NEVER mutates/saves data on its own.
  - System prompt includes Section 3 business rules for Policy Q&A and supports both **English and Roman Urdu**.
- **Endpoints**:
  1. `POST /api/ai/chat`:
     - Implements the 7 required tools: `get_headcount`, `get_attendance_summary`, `get_late_comers`, `get_leave_summary`, `get_my_leave_balance`, `get_payroll_summary`, `search_employees`.
     - Tools inject and call the exact same NestJS Services (`DashboardService`, `EmployeesService`, `LeaveService`, `PayrollService`) passing `currentUser` so role & `employeeId` data scopes are strictly enforced and numbers match the dashboards 100%.
     - If an `Employee` asks for another employee's salary or data, the service/tool refuses and the AI politely declines.
  2. `POST /api/ai/dashboard-summary` (`Admin`, `HR`): Summarizes filtered KPI JSON into 3–5 insight bullets using only those numbers.
  3. `POST /api/ai/smart-leave` (`Employee`, `HR` own): Parses natural language leave requests into `{ type, startDate, endDate, reason }`, validates with DTO/schema, retries once on failure, and falls back to `{ fallbackToManualForm: true }`.

### M9: `CommsModule` & `AuditModule`
- Announcements (`Admin`/`HR` post; all roles read) and In-App Notifications (`Own` scope).
- Immutable `AuditService` recording `{ actorId, actorRole, action, entity, entityId, before, after, createdAt }` on every create, update, approve, and finalize operation. `GET /api/audit-logs` restricted strictly to `Admin`.

## Deliverables Required
1. Complete NestJS project structure with DTOs, Entities/Schemas, Guards, Services, and Controllers.
2. `.env.example` (`PORT`, `DATABASE_URL`, `JWT_SECRET`, `AI_API_KEY`, `AI_MODEL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`).
3. Unit/e2e Jest tests verifying `409` duplicate check-in, `422` leave overlap/quota, payroll tax calculation, and Employee RBAC scope isolation.