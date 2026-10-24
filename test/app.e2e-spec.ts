import { DateTime } from 'luxon';
import request from 'supertest';
import { startServer, type RunningServer } from './utils/server.js';

/**
 * End-to-end flow over real HTTP against the compiled API and a throw-away MongoDB database:
 * first-run setup → logins → employees → attendance 409 → leave 422 → payroll tax &
 * finalize lock → Employee RBAC scope isolation → AI guardrails.
 */
describe('HCM Lite API (e2e)', () => {
  let server: RunningServer;
  const TZ = 'Asia/Karachi';
  const today = DateTime.now().setZone(TZ);
  const nextMonday = today.plus({ days: 8 - today.weekday }).startOf('day');
  const iso = (d: DateTime) => d.toISODate()!;
  const previousMonth = today.minus({ months: 1 }).toFormat('yyyy-MM');

  const ctx = {
    admin: '',
    hr: '',
    ali: '',
    sara: '',
    aliId: '',
    saraId: '',
    departmentId: '',
    designationId: '',
    annualTypeId: '',
    runId: '',
  };

  const http = () => request(server.url);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function loginAndChangePassword(email: string, temporaryPassword: string, newPassword: string) {
    const login = await http().post('/api/auth/login').send({ email, password: temporaryPassword }).expect(200);
    expect(login.body.user.mustChangePassword).toBe(true);
    const changed = await http()
      .post('/api/auth/change-password')
      .set(auth(login.body.accessToken))
      .send({ currentPassword: temporaryPassword, newPassword })
      .expect(200);
    return changed.body.accessToken as string;
  }

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  // ── M2: first-run flow (empty database, no seed data) ────────
  describe('First-run setup', () => {
    it('reports not initialized on an empty database', async () => {
      const res = await http().get('/api/setup/status').expect(200);
      expect(res.body).toEqual({ initialized: false });
    });

    it('initializes CompanySettings + the first Admin', async () => {
      const res = await http()
        .post('/api/setup/init')
        .send({
          companyName: 'E2E Corp',
          timezone: TZ,
          officeLocation: { lat: 24.8607, lng: 67.0011, radiusMeters: 150 },
          admin: { fullName: 'Admin', email: 'admin@e2e.test', password: 'AdminPass123' },
        })
        .expect(201);
      expect(res.body.settings).toMatchObject({
        companyName: 'E2E Corp',
        officeStartTime: '09:00',
        graceMinutes: 15,
        halfDayThresholdHours: 5,
        weekendDays: ['Saturday', 'Sunday'],
      });
      ctx.admin = res.body.accessToken;
      await http().get('/api/setup/status').expect(200, { initialized: true });
    });

    it('cannot be initialized twice (409)', async () => {
      await http()
        .post('/api/setup/init')
        .send({ companyName: 'Again', admin: { fullName: 'X', email: 'x@e2e.test', password: 'Password123' } })
        .expect(409);
    });

    it('creates the default leave types (Annual 14, Sick 8, Casual 10, Unpaid unlimited)', async () => {
      const res = await http().get('/api/leave-types').set(auth(ctx.admin)).expect(200);
      const quotas = Object.fromEntries(res.body.map((t: { name: string; annualQuota: number | null }) => [t.name, t.annualQuota]));
      expect(quotas).toEqual({ Annual: 14, Casual: 10, Sick: 8, Unpaid: null });
      ctx.annualTypeId = res.body.find((t: { name: string }) => t.name === 'Annual').id;
    });
  });

  // ── M1/M3: logins & employees ────────────────────────────────
  describe('Logins and employee registration', () => {
    it('Admin creates org structure and an HR login', async () => {
      ctx.departmentId = (await http().post('/api/departments').set(auth(ctx.admin)).send({ name: 'Engineering' }).expect(201)).body.id;
      ctx.designationId = (await http().post('/api/designations').set(auth(ctx.admin)).send({ name: 'Engineer' }).expect(201)).body.id;

      const hr = await http()
        .post('/api/users/hr')
        .set(auth(ctx.admin))
        .send({ fullName: 'Hina HR', email: 'hr@e2e.test' })
        .expect(201);
      ctx.hr = await loginAndChangePassword('hr@e2e.test', hr.body.temporaryPassword, 'HrPassword123');
    });

    it('HR registers employees; each gets a login with mustChangePassword', async () => {
      const ali = await http()
        .post('/api/employees')
        .set(auth(ctx.hr))
        .send({
          code: 'E-001',
          fullName: 'Ali Raza',
          email: 'ali@e2e.test',
          departmentId: ctx.departmentId,
          designationId: ctx.designationId,
          joinDate: '2025-01-01',
          basicSalary: 100_000,
        })
        .expect(201);
      expect(ali.body.login.mustChangePassword).toBe(true);
      ctx.aliId = ali.body.employee.id;

      const sara = await http()
        .post('/api/employees')
        .set(auth(ctx.hr))
        .send({
          code: 'E-002',
          fullName: 'Sara Khan',
          email: 'sara@e2e.test',
          departmentId: ctx.departmentId,
          designationId: ctx.designationId,
          joinDate: '2025-06-15',
          basicSalary: 50_000,
          status: 'probation',
        })
        .expect(201);
      ctx.saraId = sara.body.employee.id;

      // temporary-password users are blocked until they change it
      const tempLogin = await http()
        .post('/api/auth/login')
        .send({ email: 'ali@e2e.test', password: ali.body.login.temporaryPassword })
        .expect(200);
      const blocked = await http().get('/api/attendance/today').set(auth(tempLogin.body.accessToken)).expect(403);
      expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

      ctx.ali = await loginAndChangePassword('ali@e2e.test', ali.body.login.temporaryPassword, 'AliPassword123');
      ctx.sara = await loginAndChangePassword('sara@e2e.test', sara.body.login.temporaryPassword, 'SaraPassword123');
    });

    it('follows the brief’s permission matrix: Admin views employees, HR manages them', async () => {
      await http()
        .post('/api/employees')
        .set(auth(ctx.admin))
        .send({ code: 'E-999', fullName: 'Nope', email: 'nope@e2e.test', departmentId: ctx.departmentId, designationId: ctx.designationId, joinDate: '2025-01-01', basicSalary: 1 })
        .expect(403);
      await http().post('/api/employees/import?dryRun=true').set(auth(ctx.admin)).send({ csv: 'code\n' }).expect(403);
      const list = await http().get('/api/employees').set(auth(ctx.admin)).expect(200);
      expect(list.body.meta.total).toBe(2);
    });

    it('supports server-side search, filters and pagination', async () => {
      const res = await http().get('/api/employees?q=sara&status=probation&page=1&limit=5').set(auth(ctx.hr)).expect(200);
      expect(res.body.meta).toMatchObject({ page: 1, limit: 5, total: 1 });
      expect(res.body.data[0].code).toBe('E-002');
    });
  });

  // ── M4: attendance ───────────────────────────────────────────
  describe('Attendance', () => {
    it('stamps a check-in on the server', async () => {
      const res = await http().post('/api/attendance/check-in').set(auth(ctx.ali)).send({ source: 'manual' }).expect(201);
      expect(['present', 'late']).toContain(res.body.status);
      expect(res.body.date).toBe(iso(today));
    });

    it('rejects a second check-in on the same day with 409 Conflict', async () => {
      const res = await http().post('/api/attendance/check-in').set(auth(ctx.ali)).send({ source: 'manual' }).expect(409);
      expect(res.body.statusCode).toBe(409);
    });

    it('verifies camera check-ins (one face, GPS accuracy ≤ 100 m, inside the geofence)', async () => {
      const camera = { source: 'camera', faceDetected: true, faceCount: 1, latitude: 24.8612, longitude: 67.0014, accuracy: 30 };
      const multipleFaces = await http().post('/api/attendance/check-in').set(auth(ctx.sara)).send({ ...camera, faceCount: 2 }).expect(422);
      expect(multipleFaces.body.code).toBe('INVALID_FACE_COUNT');
      const inaccurate = await http().post('/api/attendance/check-in').set(auth(ctx.sara)).send({ ...camera, accuracy: 250 }).expect(422);
      expect(inaccurate.body.code).toBe('GPS_ACCURACY_TOO_LOW');
      const faraway = await http().post('/api/attendance/check-in').set(auth(ctx.sara)).send({ ...camera, latitude: 24.9 }).expect(422);
      expect(faraway.body.code).toBe('OUTSIDE_GEOFENCE');

      const ok = await http().post('/api/attendance/check-in').set(auth(ctx.sara)).send(camera).expect(201);
      expect(ok.body.checkInVerification).toMatchObject({ source: 'camera', gpsAccuracy: 30, withinRadius: true });
    });

    it('marks a check-out under 5 worked hours as half_day', async () => {
      const res = await http().post('/api/attendance/check-out').set(auth(ctx.ali)).send({}).expect(200);
      expect(res.body.status).toBe('half_day');
    });
  });

  // ── M5: leave ────────────────────────────────────────────────
  describe('Leave (422 validation)', () => {
    let wednesday: string;

    it('counts working days only (weekends skipped)', async () => {
      const res = await http()
        .get(`/api/leave/working-days?startDate=${iso(nextMonday)}&endDate=${iso(nextMonday.plus({ days: 6 }))}`)
        .set(auth(ctx.ali))
        .expect(200);
      expect(res.body.workingDays).toBe(5);
    });

    it('accepts a valid request', async () => {
      wednesday = iso(nextMonday.plus({ days: 2 }));
      const res = await http()
        .post('/api/leave/requests')
        .set(auth(ctx.ali))
        .send({ leaveTypeId: ctx.annualTypeId, startDate: iso(nextMonday), endDate: wednesday, reason: 'Family event' })
        .expect(201);
      expect(res.body).toMatchObject({ status: 'pending', workingDays: 3, leaveTypeName: 'Annual' });
    });

    it('returns 422 when dates overlap an existing pending/approved leave', async () => {
      const res = await http()
        .post('/api/leave/requests')
        .set(auth(ctx.ali))
        .send({ leaveType: 'Casual', startDate: wednesday, endDate: wednesday })
        .expect(422);
      expect(res.body.code).toBe('LEAVE_OVERLAP');
    });

    it('returns 422 when working days exceed the remaining quota', async () => {
      // 3 Annual days are already pending → 11 available; ask for 12 working days.
      const start = nextMonday.plus({ weeks: 3 });
      const res = await http()
        .post('/api/leave/requests')
        .set(auth(ctx.ali))
        .send({ leaveTypeId: ctx.annualTypeId, startDate: iso(start), endDate: iso(start.plus({ days: 15 })) })
        .expect(422);
      expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('balance shows pending days before approval (remaining = after approved, available = minus pending)', async () => {
      const balance = await http().get('/api/leave/balance').set(auth(ctx.ali)).expect(200);
      expect(balance.body.balances.find((b: { leaveType: string }) => b.leaveType === 'Annual')).toMatchObject({
        quota: 14,
        used: 0,
        pending: 3,
        remaining: 14,
        available: 11,
      });
    });

    it('only HR approves (Admin views); approval updates the balance + notifies the employee', async () => {
      const list = await http().get('/api/leave/requests?status=pending').set(auth(ctx.hr)).expect(200);
      const leaveId = list.body.data[0].id;
      await http().patch(`/api/leave/requests/${leaveId}/approve`).set(auth(ctx.admin)).send({}).expect(403);
      await http().patch(`/api/leave/requests/${leaveId}/approve`).set(auth(ctx.hr)).send({ comment: 'Enjoy' }).expect(200);
      const balance = await http().get('/api/leave/balance').set(auth(ctx.ali)).expect(200);
      expect(balance.body.balances.find((b: { leaveType: string }) => b.leaveType === 'Annual')).toMatchObject({
        quota: 14,
        used: 3,
        pending: 0,
        remaining: 11,
        available: 11,
      });
      const notifications = await http().get('/api/notifications').set(auth(ctx.ali)).expect(200);
      expect(notifications.body.data.some((n: { title: string }) => n.title === 'Leave approved')).toBe(true);
    });

    it('shows who is on leave on a date (dashboard + AI tool source)', async () => {
      const day = iso(nextMonday);
      const res = await http()
        .get(`/api/dashboard/leave-summary?startDate=${day}&endDate=${day}`)
        .set(auth(ctx.hr))
        .expect(200);
      expect(res.body.employeesOnLeave).toBe(1);
      expect(res.body.onLeaveByType).toEqual({ Annual: 1 });
      expect(res.body.onLeave[0]).toMatchObject({ fullName: 'Ali Raza', leaveType: 'Annual' });
    });
  });

  // ── M6: payroll ──────────────────────────────────────────────
  describe('Payroll', () => {
    it('HR creates a draft; payslips follow the salary structure and annual tax slabs', async () => {
      const res = await http().post('/api/payroll/runs').set(auth(ctx.hr)).send({ month: previousMonth }).expect(201);
      ctx.runId = res.body.id;
      expect(res.body.status).toBe('draft');

      const ali = res.body.payslips.find((p: { employee: { code: string } }) => p.employee.code === 'E-001');
      // basic 100,000 → gross 150,000 → annual 1,800,000 → tax 30,000 + 15% × 600,000 = 120,000
      expect(ali).toMatchObject({
        basic: 100_000,
        hra: 40_000,
        medical: 10_000,
        gross: 150_000,
        annualGross: 1_800_000,
        annualTax: 120_000,
        monthlyTax: 10_000,
        netPay: 140_000,
      });

      const sara = res.body.payslips.find((p: { employee: { code: string } }) => p.employee.code === 'E-002');
      // basic 50,000 → gross 75,000 → annual 900,000 → tax 5% × 300,000 = 15,000
      expect(sara).toMatchObject({ gross: 75_000, annualTax: 15_000, monthlyTax: 1_250, netPay: 73_750 });
    });

    it('only Admin can finalize; afterwards every edit is 403', async () => {
      await http().post(`/api/payroll/runs/${ctx.runId}/finalize`).set(auth(ctx.hr)).expect(403);
      await http().post(`/api/payroll/runs/${ctx.runId}/finalize`).set(auth(ctx.admin)).expect(200);
      const locked = await http().post(`/api/payroll/runs/${ctx.runId}/recalculate`).set(auth(ctx.hr)).expect(403);
      expect(locked.body.message).toContain('finalized');
      await http().patch(`/api/payroll/runs/${ctx.runId}`).set(auth(ctx.hr)).send({ notes: 'change' }).expect(403);
      await http().delete(`/api/payroll/runs/${ctx.runId}`).set(auth(ctx.hr)).expect(403);
    });

    it('streams the payslip PDF', async () => {
      const mine = await http().get('/api/payroll/payslips/me').set(auth(ctx.ali)).expect(200);
      const pdf = await http()
        .get(`/api/payroll/payslips/${mine.body.data[0].id}/pdf`)
        .set(auth(ctx.ali))
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    });
  });

  // ── Employee RBAC scope isolation ────────────────────────────
  describe('Employee RBAC scope isolation', () => {
    it("cannot read another employee's 360 profile", async () => {
      await http().get(`/api/employees/${ctx.saraId}`).set(auth(ctx.ali)).expect(403);
      const own = await http().get(`/api/employees/${ctx.aliId}`).set(auth(ctx.ali)).expect(200);
      expect(own.body.employee.code).toBe('E-001');
    });

    it('cannot list or search the employee directory', async () => {
      await http().get('/api/employees').set(auth(ctx.ali)).expect(403);
    });

    it("cannot read another employee's attendance, leave balance or leave list", async () => {
      await http().get(`/api/attendance?employeeId=${ctx.saraId}`).set(auth(ctx.ali)).expect(403);
      await http().get(`/api/leave/balance?employeeId=${ctx.saraId}`).set(auth(ctx.ali)).expect(403);
      await http().get(`/api/leave/requests?employeeId=${ctx.saraId}`).set(auth(ctx.ali)).expect(403);
      const own = await http().get('/api/attendance').set(auth(ctx.ali)).expect(200);
      expect(own.body.data.every((r: { employeeId: { _id: string } }) => r.employeeId._id === ctx.aliId)).toBe(true);
    });

    it("cannot read another employee's payslip (JSON or PDF)", async () => {
      const all = await http().get(`/api/payroll/payslips?employeeId=${ctx.saraId}`).set(auth(ctx.hr)).expect(200);
      const saraSlipId = all.body.data[0].id;
      await http().get(`/api/payroll/payslips/${saraSlipId}`).set(auth(ctx.ali)).expect(403);
      await http().get(`/api/payroll/payslips/${saraSlipId}/pdf`).set(auth(ctx.ali)).expect(403);
      const mine = await http().get('/api/payroll/payslips').set(auth(ctx.ali)).expect(200);
      expect(mine.body.data.every((p: { employeeId: string }) => p.employeeId === ctx.aliId)).toBe(true);
    });

    it('can edit ONLY own phone and address', async () => {
      await http().patch('/api/employees/me').set(auth(ctx.ali)).send({ basicSalary: 1_000_000 }).expect(400);
      await http().patch(`/api/employees/${ctx.aliId}`).set(auth(ctx.ali)).send({ phone: '+92 300 0000000' }).expect(403);
      const res = await http()
        .patch('/api/employees/me')
        .set(auth(ctx.ali))
        .send({ phone: '+92 300 7654321', address: 'Karachi' })
        .expect(200);
      expect(res.body).toMatchObject({ phone: '+92 300 7654321', address: 'Karachi', basicSalary: 100_000 });
    });

    it('cannot open dashboards or audit logs', async () => {
      await http().get('/api/dashboard/summary').set(auth(ctx.ali)).expect(403);
      await http().get('/api/audit-logs').set(auth(ctx.ali)).expect(403);
      await http().get('/api/audit-logs').set(auth(ctx.hr)).expect(403);
      const audit = await http().get('/api/audit-logs').set(auth(ctx.admin)).expect(200);
      expect(audit.body.meta.total).toBeGreaterThan(0);
    });
  });

  // ── M7: dashboard ────────────────────────────────────────────
  describe('Dashboard', () => {
    it('computes company/HR KPIs server-side', async () => {
      const res = await http().get('/api/dashboard/summary').set(auth(ctx.hr)).expect(200);
      expect(res.body.headcount).toMatchObject({ total: 2, active: 1, probation: 1 });
      expect(res.body.today).toMatchObject({ headcount: 2, present: 2 });
      expect(res.body.demographics.tenure.reduce((s: number, t: { count: number }) => s + t.count, 0)).toBe(2);
      expect(res.body.attritionYtd).toHaveProperty('attritionRate');
      expect(res.body.payrollCost).toBeDefined();
    });

    it('HR daily attendance board lists every employee with a status', async () => {
      const res = await http().get('/api/attendance/board').set(auth(ctx.hr)).expect(200);
      expect(res.body.total).toBe(2);
      const statuses = Object.fromEntries(res.body.data.map((r: { code: string; status: string }) => [r.code, r.status]));
      expect(statuses['E-001']).toBe('half_day');
      expect(['present', 'late']).toContain(statuses['E-002']);
      await http().get('/api/attendance/board').set(auth(ctx.ali)).expect(403);
    });

    it('Employee gets a personal dashboard (hours this week vs 40, leave left, last payslip)', async () => {
      const res = await http().get('/api/dashboard/me').set(auth(ctx.ali)).expect(200);
      expect(res.body.week.targetHours).toBe(40);
      expect(res.body.today.canCheckIn).toBe(false);
      expect(res.body.leaveBalances.find((b: { leaveType: string }) => b.leaveType === 'Annual').remaining).toBe(11);
      expect(res.body.lastPayslip).toMatchObject({ month: previousMonth, netPay: 140_000 });
    });
  });

  // ── M8: AI guardrails ────────────────────────────────────────
  describe('AI', () => {
    it('answers with aiGenerated: true and a friendly fallback when AI is not configured', async () => {
      const res = await http().post('/api/ai/chat').set(auth(ctx.ali)).send({ message: 'Meri leaves kitni baqi hain?' }).expect(200);
      expect(res.body).toMatchObject({ aiGenerated: true, status: 'disabled', fallback: true });

      const leave = await http().post('/api/ai/smart-leave').set(auth(ctx.ali)).send({ text: 'kal ki chutti chahiye' }).expect(200);
      expect(leave.body).toMatchObject({ aiGenerated: true, fallbackToManualForm: true });

      const summary = await http().post('/api/ai/dashboard-summary').set(auth(ctx.hr)).send({}).expect(200);
      expect(summary.body.aiGenerated).toBe(true);
      expect(summary.body.bullets.length).toBeGreaterThanOrEqual(3);
      expect(summary.body.bullets.length).toBeLessThanOrEqual(5);
    });

    it('limits AI to 20 requests per user per hour', async () => {
      for (let i = 0; i < 20; i++) {
        await http().post('/api/ai/chat').set(auth(ctx.sara)).send({ message: `hello ${i}` }).expect(200);
      }
      await http().post('/api/ai/chat').set(auth(ctx.sara)).send({ message: 'one too many' }).expect(429);
      // the limit is per user — another user is unaffected
      await http().post('/api/ai/chat').set(auth(ctx.admin)).send({ message: 'hi' }).expect(200);
    });
  });

  // ── M1: logout ───────────────────────────────────────────────
  describe('Logout', () => {
    it('revokes the token server-side', async () => {
      await http().post('/api/auth/logout').set(auth(ctx.hr)).expect(200, { loggedOut: true });
      await http().get('/api/auth/me').set(auth(ctx.hr)).expect(401);
    });
  });
});
