# HCM Lite — Backend API

An AI-assisted **Human Capital Management** REST API for three roles: `Admin`, `HR` and `Employee`. It is built with **NestJS 12 (TypeScript, ESM)**, **MongoDB (Mongoose)** and **Claude** for the AI features.

- 9 modules (M1–M9; M9 is two NestJS modules, comms and audit) with server-side role and data-scope checks on every request, following the challenge brief's permission matrix.
- Server-stamped attendance with a camera and GPS geofence, leave with quotas, payroll with a draft → finalize lock and PDF payslips, company/HR/personal dashboards, and an HR assistant with tool calling.
- **Zero seed data.** The database starts empty. A first-run flow creates the company settings and the first Admin.
- Tests: **78 unit and 34 end-to-end tests** (Jest). They cover 409 duplicate check-in, 422 leave overlap/quota, the tax calculation and Employee scope isolation.

---

## 1. Quick start

**Prerequisites:** Node.js **22.12+** (22.22+ or 24 recommended) and MongoDB 6+ (local, Docker or Atlas).

```bash
npm install
cp .env.example .env        # fill in JWT_SECRET (and AI_API_KEY if you have one)
npm run start:dev           # http://localhost:3000/api   ·   Swagger UI: http://localhost:3000/api/docs
```

### First run (the database is empty)

1. `GET /api/setup/status` returns `{ "initialized": false }`.
2. `POST /api/setup/init` creates the CompanySettings, the first Admin and the default leave types. It returns a JWT.

```json
{
  "companyName": "Acme Pvt Ltd",
  "timezone": "Asia/Karachi",
  "officeStartTime": "09:00",
  "graceMinutes": 15,
  "halfDayThresholdHours": 5,
  "weekendDays": ["Saturday", "Sunday"],
  "officeLocation": { "lat": 24.8607, "lng": 67.0011, "radiusMeters": 150 },
  "latePenaltyRuleEnabled": false,
  "admin": { "fullName": "System Admin", "email": "admin@acme.com", "password": "StrongPass123" }
}
```

Only `companyName` and `admin` are required. Every policy field falls back to the defaults shown above. Calling init a second time returns **409**.

**Alternative:** set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (plus optional `COMPANY_NAME`) in `.env`. The startup hook then initializes the system automatically if it is still empty.

3. Demo flow, as in the brief:
   1. Admin creates a department, designations and an HR login (`POST /api/users/hr`).
   2. HR registers employees (`POST /api/employees`).
   3. Each employee signs in with the returned temporary password, **must** call `POST /api/auth/change-password`, and can then check in.

### Setting the AI key

Put an Anthropic key in `AI_API_KEY` (server-side only; the browser never sees it). Optionally change `AI_MODEL` (default `claude-opus-5-5`). Without a key every AI endpoint still answers, with a friendly fallback and `aiGenerated: true`.

### Scripts

| Script | What it does |
|---|---|
| `npm run start:dev` | Watch mode |
| `npm run build` / `npm run start:prod` | Compile to `dist/` / run the compiled server |
| `npm test` | Unit tests (Jest, ESM) |
| `npm run test:e2e` | Builds into `dist-e2e/`, then runs the e2e suite against that server and a throw-away DB |
| `npm run test:all` | Both suites |
| `npm run typecheck` · `npm run lint` · `npm run format` | `tsc --noEmit` · oxlint · prettier |

---

## 2. Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | – | HTTP port (default `3000`). All routes are under `/api`. |
| `DATABASE_URL` | ✅ | MongoDB connection string, e.g. `mongodb://127.0.0.1:27017/hcm_lite` |
| `JWT_SECRET` | ✅ | Signing secret, minimum 16 characters (use 32+ in production) |
| `JWT_EXPIRES_IN` | – | Token lifetime (default `1d`) |
| `AI_API_KEY` | – | Anthropic API key, read **only on the server** |
| `AI_MODEL` | – | Claude model id (default `claude-opus-5-5`) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | – | Optional first-run bootstrap |
| `COMPANY_NAME`, `ADMIN_FULL_NAME`, `APP_TIMEZONE` | – | Used by the bootstrap and as the default timezone |
| `CORS_ORIGIN` | – | Comma-separated allowed origins (default: all) |
| `THROTTLE_LIMIT` | – | General rate limit per user/IP per minute (default `300`). AI is fixed at 20/user/hour. |

Commit `.env.example` only. `.env` is git-ignored.

---

## 3. Architecture

```
src/
├── main.ts / app.module.ts / app.setup.ts   # bootstrap, global pipes/filters/guards, Swagger
├── config/env.validation.ts                 # fail-fast env validation
├── database/database.module.ts              # Mongo connection + every model registered once (global)
├── common/                                  # guards, decorators, pipes, filters, utils
│   ├── guards/       JwtAuthGuard · RolesGuard · UserThrottlerGuard
│   ├── decorators/   @Public · @Roles('Admin','HR','Employee') · @CurrentUser · @AllowPendingPasswordChange · @ThrottleScope
│   └── utils/        scope.util (Employee data-scope) · date.util (timezone-safe dates) · keyed-mutex …
└── modules/
    ├── auth/        (M1) login/logout, change password, users (HR logins, deactivate, reset)
    ├── setup/       (M2) first-run, company settings, departments, designations, leave types, holidays, calendar
    ├── employees/   (M3) registration, search/filter/pagination, 360 profile, self-service, CSV import/export
    ├── attendance/  (M4) check-in/out, camera geofence, corrections, daily board, end-of-day close job
    ├── leave/       (M5) requests, working days, quotas & balances, approvals, cancellation
    ├── payroll/     (M6) calculator, draft → finalize lock, payslips, PDF
    ├── dashboard/   (M7) company/HR KPIs, trends, demographics, personal dashboard, attrition risk, anomalies
    ├── ai/          (M8) Claude tool calling, dashboard summary, smart leave, ai_logs
    ├── comms/       (M9) announcements, in-app notifications
    └── audit/       (M9) immutable audit trail
```

**Design notes**
- **Database choice.** The brief allows any database; prompt.md suggests *PostgreSQL + Prisma* or *MongoDB + @nestjs/mongoose*. This uses **MongoDB**. Every dashboard number comes from aggregation pipelines (`$group`, `$facet`, `$unwind`, `$switch`). Unique indexes back the business rules, for example one attendance record per `{employeeId, date}`.
- **Every service takes the current user.** Data scope is enforced inside the services, not only by controller guards. The AI tools call these same methods, so the assistant can never see more than the user can, and its numbers match the dashboards.
- **Dates.** Calendar days are stored as `YYYY-MM-DD` strings in the **company timezone** (default `Asia/Karachi`), so results never shift when the server runs in UTC. Instants such as check-in times are real `Date`s stamped by the server.
- **Rule snapshots.** Attendance records and payroll runs store the rules in force when they were created, so policy changes apply to **new records only**.
- **Module graph.** Dependencies form a DAG (no circular imports, which matters under ESM).

---

## 4. Roles and permissions (brief §8 checklist)

| # | Functionality | Admin | HR | Employee |
|---|---|---|---|---|
| 01 | First-run setup | Manage | — | — |
| 02 | Login, logout, change password | Own | Own | Own |
| 03 | Company settings | Manage | View | — (relevant policies only) |
| 04 | Departments, designations, leave types & quotas, holidays | Manage | View | leave types & holidays |
| 05 | Create HR logins; deactivate / reset any login | Manage | — | — |
| 06 | Register an employee (creates login), edit details | View | Manage | own phone & address |
| 07 | Directory, search, filters, Employee 360 | All | All | Own |
| 08 | CSV import (dry run) / export | — | Manage | — |
| 09 | Check in / check out | — | Own* | Own |
| 10 | Attendance calendar & daily board | All | All | Own |
| 11 | Attendance correction | View | Approve | Request |
| 12 | Apply / cancel leave, balance, history | — | Own* | Own |
| 13 | Approve / reject leave with a comment | View | Approve | — |
| 14 | Salary structure (basic → HRA, medical, gross) | View | Manage | — |
| 15 | Monthly payroll draft | View | Manage | — |
| 16 | Finalize payroll (locks the month) | Manage | — | — |
| 17 | Payslips with PDF | All | All | Own (finalized) |
| 18 | Dashboards | Company | HR | Personal |
| 19 | AI chat on real data | All data | HR data | Own data |
| 20 | AI dashboard summary | ✅ | ✅ | — |
| 21 | Smart leave | — | Own* | Own |
| 22 | Policy Q&A | ✅ | ✅ | ✅ |
| 23 | Announcements | Post | Post | Read |
| 24 | In-app notifications | Own | Own | Own |
| 25 | Audit log | View | — | — |

\* Requires an employee profile linked to the login (`POST /api/users/hr` accepts `employeeId`, or promote an employee login with `PATCH /api/users/:id/role`).

An `Employee` is always pinned to `employeeId: user.employeeId`. Asking for anyone else's profile, attendance, leave, balance or payslip returns **403**. HR cannot approve their own leave or correction requests.

---

## 5. API reference (prefix `/api`)

Full interactive docs are at **`/api/docs`**. The OpenAPI JSON is at `/api/docs-json`, which you can import into Postman.

### M1 – Auth & users
| Method | Path | Who |
|---|---|---|
| POST | `/auth/login` | public (10/min per IP) |
| POST | `/auth/logout` | any (revokes all of the user's tokens) |
| POST | `/auth/change-password` | any (returns a fresh token; old tokens are revoked) |
| GET | `/auth/me` | any |
| GET · POST | `/users` · `/users/hr` | Admin |
| PATCH | `/users/:id/deactivate` · `/users/:id/activate` · `/users/:id/role` | Admin |
| POST | `/users/:id/reset-password` | Admin |

### M2 – Setup
| Method | Path | Who |
|---|---|---|
| GET | `/setup/status` | public |
| POST | `/setup/init` | public, works once |
| GET / PATCH | `/settings` | Admin & HR view / Admin |
| GET | `/settings/policies` | all (hours, grace, weekend, quotas, holidays, payroll rules) |
| CRUD | `/departments`, `/designations` | Admin (HR can view) |
| GET / CRUD | `/leave-types`, `/holidays` | all view / Admin manage |

### M3 – Employees
| Method | Path | Notes |
|---|---|---|
| POST | `/employees` | HR. Auto-creates the login and returns a one-time `temporaryPassword` |
| GET | `/employees?q=&departmentId=&designationId=&status=&page=&limit=&sortBy=&sortOrder=` | Admin, HR |
| GET | `/employees/:id` | 360 profile: job, salary structure, account, month attendance, leave balances, payslips |
| GET / PATCH | `/employees/me` | own profile / phone and address **only** (other fields → 400) |
| PATCH | `/employees/:id` | HR. Exiting deactivates the login |
| POST | `/employees/import?dryRun=true\|false` | HR. Multipart `file` (or JSON `{ "csv": "…" }`) |
| GET | `/employees/import/template` · `/employees/export` | HR, CSV |

**CSV import.** Columns: `code, fullName, email, phone, address, gender, department, designation, joinDate, status, exitDate, basicSalary`. Headers are case- and space-insensitive. Department and designation can be a name or a code.

Every row is checked for:
- required fields
- unique `code` and `email`, against the database **and** within the file
- email format
- known department and designation
- ISO dates (`YYYY-MM-DD`)
- `basicSalary > 0`

The response is `{ valid, errors: [{ row, field, reason }], totalRows, validRows, invalidRows, inserted }`, where `row` is the line number in the file (the header is line 1). Records are inserted **only** when `dryRun=false` and every row is valid (all or nothing; otherwise 422 with the same body). New logins and their temporary passwords are returned in `credentials`.

### M4 – Attendance
| Method | Path | Notes |
|---|---|---|
| POST | `/attendance/check-in` | Server-stamped. A **second check-in on the same day returns 409** |
| POST | `/attendance/check-out` | Fewer than `halfDayThresholdHours` worked → `half_day` |
| GET | `/attendance/today` · `/attendance/me?from=&to=` | own status / own calendar |
| GET | `/attendance` · `/attendance/:id` | Admin/HR: all · Employee: own |
| GET | `/attendance/board?date=&departmentId=` | Admin, HR. Every employee: present / late / half_day / on_leave / not_checked_in / absent / weekend |
| POST | `/attendance/corrections` | Employee request (date, `HH:mm` times, reason) |
| GET | `/attendance/corrections` | Admin/HR: all · Employee: own |
| PATCH | `/attendance/corrections/:id/approve` · `/reject` | HR. Updates the record and writes an audit log |
| POST | `/attendance/close-days` | Admin, HR. Runs the end-of-day close now |

**Statuses**
- `late` if check-in is after `officeStartTime + graceMinutes` (09:15), otherwise `present`.
- `half_day` if fewer than 5 hours are worked.
- `missing_checkout` if there is a check-in without a check-out.
- `absent` for a working day with no record and no approved leave. `on_leave` if there is approved leave.

The last two are written by the **end-of-day close job**. It runs every 30 minutes and on startup, processing each finished day since the last run, and never back-fills before the setup date.

**Camera check-in** (`source: "camera"`, with `faceDetected`, `faceCount`, `latitude`, `longitude`, `accuracy`) is rejected with **422** and a `code`:
- `FACE_NOT_DETECTED` or `INVALID_FACE_COUNT` unless `faceDetected === true` and `faceCount === 1`
- `GPS_ACCURACY_TOO_LOW` if `accuracy > 100` m
- `OUTSIDE_GEOFENCE` when outside `radiusMeters`, measured with the Haversine distance (`geolib.isPointWithinRadius`)

Only the verification result is stored (`distanceMeters`, `gpsAccuracy`, …), never photos or raw coordinates. A failed check can be fixed with an HR-approved correction.

### M5 – Leave
| Method | Path | Notes |
|---|---|---|
| POST | `/leave/requests` | `leaveTypeId` (or `leaveType` name), `startDate`, `endDate`, `reason` |
| GET | `/leave/requests` · `/leave/requests/:id` | scoped |
| PATCH | `/leave/requests/:id/approve` · `/reject` | HR, with a comment → notification and audit log |
| PATCH | `/leave/requests/:id/cancel` | own: pending, or approved before it starts |
| GET | `/leave/balance?year=&employeeId=` | `quota`, `used` (approved), `pending`, `remaining` (= quota − approved), `available` (= remaining − pending) |
| GET | `/leave/working-days?startDate=&endDate=` | preview |

Working days skip the configured weekend days and public holidays. **422** is returned with a `code` for:
- `LEAVE_OVERLAP`: the request overlaps a pending or approved leave.
- `INSUFFICIENT_BALANCE`: more working days than are `available` for that calendar year. Approval re-checks this too.
- `NO_WORKING_DAYS`, `INVALID_RANGE`, …

Quotas: Annual 14, Sick 8, Casual 10, Unpaid unlimited. Approving a leave retroactively converts already-closed `absent` days into `on_leave`.

### M6 – Payroll
| Method | Path | Who |
|---|---|---|
| POST | `/payroll/runs` `{ month: "YYYY-MM" }` | HR, creates the **draft** and its payslips |
| GET | `/payroll/runs` · `/payroll/runs/:id` | Admin, HR |
| PATCH · POST · DELETE | `/payroll/runs/:id` · `/:id/recalculate` · `/:id` | HR (403 once finalized) |
| POST | `/payroll/runs/:id/finalize` | **Admin only** → locked; employees are notified |
| GET | `/payroll/payslips` · `/payroll/payslips/me` · `/payroll/payslips/:id` | scoped (Employees: own, finalized) |
| GET | `/payroll/payslips/:id/pdf` | streams a PDF (pdfkit) |
| GET | `/payroll/calculator?basic=` | Admin, HR what-if helper |

**Payroll formulas**
```
hra = 0.40 × basic        medical = 0.10 × basic        gross = 1.5 × basic
perDay = gross / workingDaysInMonth        proratedGross = perDay × eligible working days (joiners/leavers)
deductionDays = absent + unpaidLeave + 0.5 × halfDays (+ floor(lates/3) × 0.5 when latePenaltyRuleEnabled)
attendanceDeduction = deductionDays × perDay
annualTax(gross × 12):  ≤600k → 0 · ≤1.2M → 5% above 600k · ≤2.4M → 30,000 + 15% above 1.2M
                        ≤3.6M → 210,000 + 25% above 2.4M · above → 510,000 + 35% above 3.6M
monthlyTax = annualTax / 12        netPay = proratedGross − attendanceDeduction − monthlyTax
```

Two guards apply: the deduction is capped at the prorated gross, and net pay is floored at 0.

### M7 – Dashboards (filters `startDate`, `endDate`, `departmentId`)

| Endpoint | Who | What it returns |
|---|---|---|
| `GET /dashboard/summary` | Admin, HR | everything below in one response |
| `/today` | Admin, HR | headcount, present, late, on leave (by type), not checked in, pending approvals |
| `/headcount` · `/attrition` | Admin, HR | active + probation on the end date · exits ÷ average headcount × 100 (summary adds **YTD**) |
| `/attendance` · `/attendance-trend` | Admin, HR | rate = (present + late + missing_checkout + 0.5 × half_day) ÷ (working-day records − on_leave); late % = late ÷ (present + late); per department; daily series |
| `/late-comers` · `/absenteeism` | Admin, HR | top late-comers · absent ÷ expected working days per department |
| `/leave-utilization` · `/leave-summary` | Admin, HR | approved days ÷ (quota × headcount) per type and department · requests by status + **who is on leave** |
| `/payroll-cost` · `/average-salary` | Admin, HR | Σ gross / net by month and department · mean gross by department and designation |
| `/demographics` | Admin, HR | gender mix and tenure bands |
| `/attrition-risk` · `/absence-anomalies` *(bonus)* | Admin, HR | explainable 0–100 risk score · flags (high absence, 3+ consecutive, Friday/Monday pattern, missing check-outs) |
| `GET /dashboard/me` | any with a profile | personal: today's check-in state, hours this week vs 40 h, late count, leave balance, last payslip, announcements, unread notifications |

### M8 – AI (20 requests per user per hour across all AI endpoints, 15 s timeout)
| Method | Path | Who |
|---|---|---|
| POST | `/ai/chat` `{ message, history? }` | all roles |
| POST | `/ai/dashboard-summary` `{ startDate?, endDate?, departmentId? }` | Admin, HR |
| POST | `/ai/smart-leave` `{ text }` | Employee, HR (own) |
| GET | `/ai-logs` | Admin |

### M9 – Comms & audit
| Method | Path | Who |
|---|---|---|
| POST · PATCH · DELETE | `/announcements` | Admin, HR (HR: own announcements only) |
| GET | `/announcements` | all |
| GET | `/notifications` · `/notifications/unread-count` | own |
| PATCH | `/notifications/:id/read` · `/notifications/read-all` | own |
| GET | `/audit-logs` · `/audit-logs/:id` | **Admin only** |

The audit trail is **immutable**: `{ actorId, actorRole, action, entity, entityId, before, after, createdAt }` is written on every create, update, approve, reject and finalize. There is no update or delete path, and schema hooks block every update and delete query.

---

## 6. AI module (Claude)

- **Model:** `AI_MODEL`, default `claude-opus-5-5`, via the official `@anthropic-ai/sdk`.
  - Low effort keeps answers inside the 15 s budget.
  - Server-side refusal fallback is enabled (`fallbacks: "default"`).
- **Chat with tools.** The SDK tool runner exposes 7 read-only tools:
  - `get_headcount`, `get_attendance_summary`, `get_late_comers`, `get_leave_summary` (also answers *"who is on leave today?"*) → `DashboardService`
  - `get_my_leave_balance` → `LeaveService`
  - `get_payroll_summary` → `PayrollService`
  - `search_employees` → `EmployeesService`

  Every tool passes the **current user**, so an Employee asking for a colleague's salary gets `ACCESS_DENIED` and the assistant politely declines (in English or Roman Urdu).
- **Guardrails**
  - The key is server-side only.
  - `@Throttle` limits each user to 20 requests per hour, in one bucket shared by all AI routes.
  - `AbortSignal.timeout(15000)` on the model call, plus an RxJS `timeout` interceptor, both return friendly fallbacks.
  - Every call is logged in `ai_logs` (`userId, role, feature, prompt, toolsCalled, response, status, latencyMs`).
  - Every response includes `aiGenerated: true`.
  - The AI never touches the database directly and never writes data.
- **Policy Q&A.** The Section 3 rules, filled with the company's live settings, sit in the system prompt (English and **Roman Urdu**). The model answers only from them or says it doesn't know.
- **Dashboard summary.** The server computes the KPI JSON and the model returns 3–5 bullets as structured output. A grounding check rejects any number that is not in the JSON; the model gets one retry, and after that the API falls back to rule-based bullets.
- **Smart leave.** Natural language (e.g. *"I need next Monday and Tuesday off for my sister's wedding"*) is turned into `{ type, startDate, endDate, reason }`. A wedding maps to **Casual**, and a working-day calendar is given to the model so it gets the dates right. The result is validated with a DTO and previewed against the leave rules, with one retry on failure; otherwise the response is `{ fallbackToManualForm: true }`. **Nothing is submitted.** The user confirms the pre-filled form.

---

## 7. Testing

```bash
npm test            # 78 unit tests
npm run test:e2e    # 34 e2e tests (builds into dist-e2e/, starts that server on a free port)
```

| Requirement | Unit tests | E2E (`test/app.e2e-spec.ts`) |
|---|---|---|
| **409** duplicate check-in | `attendance.service.spec.ts` (pre-check, unique-index race, concurrent requests) | second `POST /attendance/check-in` → 409 |
| **422** leave overlap / quota | `leave.service.spec.ts` | `LEAVE_OVERLAP`, `INSUFFICIENT_BALANCE` |
| Payroll tax calculation | `payroll.calculator.spec.ts` (every slab boundary, proration, deductions, late rule) | payslip figures for basic 100k / 50k |
| Employee RBAC scope isolation | `employee-scope.spec.ts`, `scope.util.spec.ts`, `roles.guard.spec.ts` | profile, list, attendance, balance, payslip JSON/PDF, dashboards, audit → 403; Admin cannot register employees or approve leave |
| Attendance rules & geofence | `attendance.rules.spec.ts` | camera 422 codes, daily board |
| KPI formulas, AI grounding, Claude SDK integration | `kpi.util.spec.ts`, `grounding.util.spec.ts`, `ai.service.spec.ts` (real SDK, fake `fetch`) | AI fallbacks, **429** on the 21st AI request/hour, who-is-on-leave, personal dashboard, logout |

**E2E database selection:**
1. `E2E_MONGO_URI` if set.
2. Otherwise a local MongoDB on `127.0.0.1:27017`.
3. Otherwise `mongodb-memory-server`.

A unique `hcm_lite_e2e_*` database is created and dropped afterwards. The suite drives the compiled server over HTTP, because Jest on Node 22 cannot load the CommonJS `@nestjs/throttler` on top of the ESM-only NestJS 12 packages in-process.

---

## 8. Security checklist

- **Passwords:** bcrypt (cost 10). Temporary passwords are random and must be changed at first sign-in. Login timing is equalized for unknown emails.
- **Tokens:** JWTs carry a token version. Logout, password change/reset, deactivation and role changes revoke old tokens immediately, because the user is re-loaded on every request.
- **Input validation:** the global `ValidationPipe` runs with `whitelist` + `forbidNonWhitelisted`. ObjectId params are validated, regex input is escaped, and CSV uploads are limited to 2 MB and 1000 rows.
- **HTTP hardening:** Helmet, configurable CORS, rate limits (general, login, setup and AI), and Mongo errors mapped to clean 400/409 responses.
- **Data minimization:** office coordinates are visible to Admin/HR only; employees get the policy subset.

---

## 9. What is done / not done

**Done:**
- All 9 modules (M1–M9) and the 25 functionalities of the brief's checklist, as a REST API.
- Every bonus item that belongs on the server:
  - camera + location check-in verification (the server checks face count, GPS accuracy and the Haversine geofence)
  - attrition risk score
  - absence anomaly flags
  - late penalty rule (3 lates = 0.5 day)
  - Roman Urdu in the AI
- First-run flow, Swagger docs, and unit + e2e tests.

**Not in this repository:**
- The **web frontend** (built by the frontend team) and the optional mobile app. Face detection itself (face-api.js / MediaPipe) runs on the client, which sends the result (`faceDetected`, `faceCount`, GPS) to `POST /api/attendance/check-in`.
- Face *matching* against an enrolled face and liveness checks (extra bonus).
- Dark mode / PWA (frontend items).

**Notes:**
- **CSV export library:** the deprecated `json2csv` package was replaced with its maintained successor `@json2csv/plainjs`.
- **No database transactions:** a standalone local MongoDB has no transactions. Multi-document writes use compensating cleanup instead, and the rules are backed by unique indexes and per-employee locks.
- **AI provider:** the AI layer uses the Anthropic Claude SDK. The brief allows any LLM with tool calling.
