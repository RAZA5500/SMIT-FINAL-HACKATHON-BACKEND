import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { DateTime } from 'luxon';
import { Model, Types } from 'mongoose';
import type { AuthUser } from '../../common/interfaces/auth-user.interface.js';
import { startOfMonth, yearOf } from '../../common/utils/date.util.js';
import { percent, round2 } from '../../common/utils/number.util.js';
import { requireEmployeeId } from '../../common/utils/scope.util.js';
import { Attendance, type AttendanceDocument } from '../attendance/schemas/attendance.schema.js';
import { Announcement, type AnnouncementDocument } from '../comms/schemas/announcement.schema.js';
import { Notification, type NotificationDocument } from '../comms/schemas/notification.schema.js';
import { LeaveService } from '../leave/leave.service.js';
import { Payslip, type PayslipDocument } from '../payroll/schemas/payslip.schema.js';
import { CalendarService } from '../setup/calendar.service.js';
import { SettingsService } from '../setup/settings.service.js';

export const WEEKLY_TARGET_HOURS = 40;

/**
 * Personal (self-service) dashboard: today's check-in state, hours this week vs 40 h,
 * late count, leave balance, last payslip, announcements and unread notifications.
 * Always scoped to the caller's own employee profile.
 */
@Injectable()
export class PersonalDashboardService {
  constructor(
    @InjectModel(Attendance.name) private readonly attendanceModel: Model<AttendanceDocument>,
    @InjectModel(Payslip.name) private readonly payslipModel: Model<PayslipDocument>,
    @InjectModel(Announcement.name) private readonly announcementModel: Model<AnnouncementDocument>,
    @InjectModel(Notification.name) private readonly notificationModel: Model<NotificationDocument>,
    private readonly settings: SettingsService,
    private readonly calendar: CalendarService,
    private readonly leave: LeaveService,
  ) {}

  async getMine(user: AuthUser) {
    const employeeId = new Types.ObjectId(requireEmployeeId(user));
    const settings = await this.settings.get();
    const now = DateTime.now().setZone(settings.timezone);
    const today = now.toISODate()!;
    const weekStart = now.startOf('week').toISODate()!; // ISO week → Monday
    const monthStart = startOfMonth(today);

    const [calendar, weekRecords, monthRows, balances, lastPayslip, announcements, unreadNotifications] = await Promise.all([
      this.calendar.forRange(today, today),
      this.attendanceModel.find({ employeeId, date: { $gte: weekStart, $lte: today } }).sort({ date: 1 }).exec(),
      this.attendanceModel
        .aggregate<{ _id: string; count: number; lateArrivals: number }>([
          { $match: { employeeId, date: { $gte: monthStart, $lte: today }, isWorkingDay: true } },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 },
              lateArrivals: { $sum: { $cond: [{ $gt: ['$lateMinutes', 0] }, 1, 0] } },
            },
          },
        ])
        .exec(),
      this.leave.balancesFor(String(employeeId), yearOf(today)),
      this.payslipModel.findOne({ employeeId, status: 'finalized' }).sort({ month: -1 }).exec(),
      this.announcementModel.find().sort({ pinned: -1, createdAt: -1 }).limit(5).exec(),
      this.notificationModel.countDocuments({ userId: new Types.ObjectId(user.userId), isRead: false }).exec(),
    ]);

    const todayRecord = weekRecords.find((r) => r.date === today) ?? null;
    let workedMinutes = weekRecords.reduce((sum, r) => sum + (r.workedMinutes ?? 0), 0);
    const openSession = !!todayRecord?.checkInAt && !todayRecord.checkOutAt;
    if (openSession) workedMinutes += Math.max(0, Math.floor((Date.now() - todayRecord!.checkInAt!.getTime()) / 60_000));
    const hoursWorked = round2(workedMinutes / 60);
    const monthCount = (status: string) => monthRows.find((r) => r._id === status)?.count ?? 0;

    return {
      date: today,
      timezone: settings.timezone,
      today: {
        isWorkingDay: calendar.isWorkingDay(today),
        record: todayRecord?.toJSON() ?? null,
        canCheckIn: !todayRecord,
        canCheckOut: openSession,
      },
      week: {
        startDate: weekStart,
        hoursWorked,
        targetHours: WEEKLY_TARGET_HOURS,
        progressPercent: percent(hoursWorked, WEEKLY_TARGET_HOURS),
      },
      month: {
        startDate: monthStart,
        lateCount: monthRows.reduce((sum, r) => sum + r.lateArrivals, 0),
        present: monthCount('present') + monthCount('late'),
        halfDays: monthCount('half_day'),
        missingCheckouts: monthCount('missing_checkout'),
        absent: monthCount('absent'),
        onLeave: monthCount('on_leave'),
      },
      leaveBalances: balances,
      lastPayslip: lastPayslip
        ? {
            id: String(lastPayslip._id),
            month: lastPayslip.month,
            gross: lastPayslip.gross,
            netPay: lastPayslip.netPay,
            currency: lastPayslip.currency,
          }
        : null,
      announcements: announcements.map((a) => a.toJSON()),
      unreadNotifications,
    };
  }
}
