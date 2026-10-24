import { UnprocessableEntityException } from '@nestjs/common';
import { DateTime } from 'luxon';
import {
  deriveAttendanceStatus,
  evaluateCheckIn,
  evaluateCheckOut,
  verifyCameraCheckIn,
  type AttendanceRules,
} from './attendance.rules.js';

const rules: AttendanceRules = {
  timezone: 'Asia/Karachi',
  officeStartTime: '09:00',
  graceMinutes: 15,
  halfDayThresholdHours: 5,
};
const at = (time: string, date = '2026-10-26') => DateTime.fromISO(`${date}T${time}`, { zone: rules.timezone }).toJSDate();

describe('Attendance rules', () => {
  describe('check-in status (officeStartTime + graceMinutes)', () => {
    it('is present up to and including 09:15', () => {
      expect(evaluateCheckIn(at('08:50'), '2026-10-26', rules)).toEqual({ status: 'present', lateMinutes: 0 });
      expect(evaluateCheckIn(at('09:15:00'), '2026-10-26', rules).status).toBe('present');
    });

    it('is late after 09:15 and records minutes after office start', () => {
      expect(evaluateCheckIn(at('09:16'), '2026-10-26', rules)).toEqual({ status: 'late', lateMinutes: 16 });
      expect(evaluateCheckIn(at('10:30'), '2026-10-26', rules)).toEqual({ status: 'late', lateMinutes: 90 });
    });

    it('evaluates in the company timezone, not the server timezone', () => {
      // 04:10 UTC = 09:10 in Karachi (UTC+5) → present
      expect(evaluateCheckIn(new Date('2026-10-26T04:10:00Z'), '2026-10-26', rules).status).toBe('present');
      // 04:20 UTC = 09:20 in Karachi → late
      expect(evaluateCheckIn(new Date('2026-10-26T04:20:00Z'), '2026-10-26', rules).status).toBe('late');
    });
  });

  describe('check-out', () => {
    it('worked hours below 5 → half_day', () => {
      expect(evaluateCheckOut(at('09:00'), at('13:59'), 'present', rules)).toEqual({ status: 'half_day', workedMinutes: 299 });
    });

    it('5 hours or more keeps the check-in status', () => {
      expect(evaluateCheckOut(at('09:00'), at('14:00'), 'present', rules).status).toBe('present');
      expect(evaluateCheckOut(at('09:30'), at('18:00'), 'late', rules).status).toBe('late');
    });

    it('a past day without check-out is missing_checkout', () => {
      const derived = deriveAttendanceStatus({ date: '2026-10-26', today: '2026-10-27', checkInAt: at('09:00'), checkOutAt: null, rules });
      expect(derived.status).toBe('missing_checkout');
    });
  });

  describe('camera geofence verification', () => {
    const office = { lat: 24.8607, lng: 67.0011, radiusMeters: 150 };
    const good = { faceDetected: true, faceCount: 1, latitude: 24.8612, longitude: 67.0014, accuracy: 25 };
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
        return null;
      } catch (error) {
        expect(error).toBeInstanceOf(UnprocessableEntityException);
        return ((error as UnprocessableEntityException).getResponse() as { code: string }).code;
      }
    };

    it('accepts one face, accuracy ≤ 100 m, inside the radius — storing only the verification result', () => {
      const result = verifyCameraCheckIn(good, office);
      expect(result.withinRadius).toBe(true);
      expect(result.distanceMeters).toBeGreaterThan(0);
      expect(result.distanceMeters).toBeLessThan(150);
      expect(result.gpsAccuracy).toBe(25);
      expect(result).not.toHaveProperty('latitude');
      expect(result).not.toHaveProperty('photo');
    });

    it('rejects when no face is detected or the face count is not exactly 1', () => {
      expect(codeOf(() => verifyCameraCheckIn({ ...good, faceDetected: false }, office))).toBe('FACE_NOT_DETECTED');
      expect(codeOf(() => verifyCameraCheckIn({ ...good, faceCount: 2 }, office))).toBe('INVALID_FACE_COUNT');
      expect(codeOf(() => verifyCameraCheckIn({ ...good, faceCount: 0 }, office))).toBe('INVALID_FACE_COUNT');
    });

    it('rejects GPS accuracy worse than 100 m (100 m is still accepted)', () => {
      expect(codeOf(() => verifyCameraCheckIn({ ...good, accuracy: 101 }, office))).toBe('GPS_ACCURACY_TOO_LOW');
      expect(codeOf(() => verifyCameraCheckIn({ ...good, accuracy: 100 }, office))).toBeNull();
    });

    it('rejects a location outside the office radius (Haversine distance)', () => {
      expect(codeOf(() => verifyCameraCheckIn({ ...good, latitude: 24.8707 }, office))).toBe('OUTSIDE_GEOFENCE');
    });

    it('rejects when the office location is not configured', () => {
      expect(codeOf(() => verifyCameraCheckIn(good, { lat: null, lng: null, radiusMeters: 150 }))).toBe(
        'OFFICE_LOCATION_NOT_CONFIGURED',
      );
    });
  });
});
