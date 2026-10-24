import { UnprocessableEntityException } from '@nestjs/common';
import { getDistance, isPointWithinRadius } from 'geolib';
import { DateTime } from 'luxon';
import type { AttendanceStatus, LocationVerification } from './schemas/attendance.schema.js';

/**
 * Pure attendance rules (no I/O) — status calculation and camera/GPS geofence checks.
 */

export const MAX_GPS_ACCURACY_METERS = 100;
export const REQUIRED_FACE_COUNT = 1;

export interface AttendanceRules {
  timezone: string;
  officeStartTime: string;
  graceMinutes: number;
  halfDayThresholdHours: number;
}

export interface CheckInEvaluation {
  status: Extract<AttendanceStatus, 'present' | 'late'>;
  /** Minutes after the office start time (0 when on time). */
  lateMinutes: number;
}

/** `late` when checked in after officeStartTime + graceMinutes (e.g. after 09:15), else `present`. */
export function evaluateCheckIn(checkInAt: Date, date: string, rules: AttendanceRules): CheckInEvaluation {
  const [hour, minute] = rules.officeStartTime.split(':').map(Number);
  const officeStart = DateTime.fromISO(date, { zone: rules.timezone }).set({
    hour,
    minute,
    second: 0,
    millisecond: 0,
  });
  const lateAfter = officeStart.plus({ minutes: rules.graceMinutes });
  const checkIn = DateTime.fromJSDate(checkInAt).setZone(rules.timezone);
  if (checkIn > lateAfter) {
    return { status: 'late', lateMinutes: Math.floor(checkIn.diff(officeStart, 'minutes').minutes) };
  }
  return { status: 'present', lateMinutes: 0 };
}

export interface CheckOutEvaluation {
  status: Extract<AttendanceStatus, 'present' | 'late' | 'half_day'>;
  workedMinutes: number;
}

/** On check-out: worked hours below the half-day threshold (5h) → `half_day`. */
export function evaluateCheckOut(
  checkInAt: Date,
  checkOutAt: Date,
  checkInStatus: CheckInEvaluation['status'],
  rules: Pick<AttendanceRules, 'halfDayThresholdHours'>,
): CheckOutEvaluation {
  const workedMinutes = Math.max(0, Math.floor((checkOutAt.getTime() - checkInAt.getTime()) / 60_000));
  const status = workedMinutes < rules.halfDayThresholdHours * 60 ? 'half_day' : checkInStatus;
  return { status, workedMinutes };
}

/**
 * Full status for a record with known times (used when HR approves a correction).
 * Past days without a check-out are `missing_checkout`.
 */
export function deriveAttendanceStatus(params: {
  date: string;
  today: string;
  checkInAt: Date;
  checkOutAt: Date | null;
  rules: AttendanceRules;
}): { status: AttendanceStatus; lateMinutes: number; workedMinutes: number | null } {
  const checkIn = evaluateCheckIn(params.checkInAt, params.date, params.rules);
  if (params.checkOutAt) {
    const checkOut = evaluateCheckOut(params.checkInAt, params.checkOutAt, checkIn.status, params.rules);
    return { status: checkOut.status, lateMinutes: checkIn.lateMinutes, workedMinutes: checkOut.workedMinutes };
  }
  return {
    status: params.date < params.today ? 'missing_checkout' : checkIn.status,
    lateMinutes: checkIn.lateMinutes,
    workedMinutes: null,
  };
}

export interface CameraPayload {
  faceDetected?: boolean;
  faceCount?: number;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
}

export interface OfficeGeofence {
  lat: number | null;
  lng: number | null;
  radiusMeters: number;
}

function reject(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new UnprocessableEntityException({
    statusCode: 422,
    error: 'Unprocessable Entity',
    code,
    message,
    ...extra,
  });
}

/**
 * Camera check-in verification. Rejects (422) unless exactly one face was detected,
 * GPS accuracy is ≤ 100 m and the Haversine distance to the office is within the radius.
 * Returns the verification result to store — never the photo or raw coordinates.
 */
export function verifyCameraCheckIn(payload: CameraPayload, office: OfficeGeofence, now = new Date()): LocationVerification {
  if (payload.faceDetected !== true) {
    reject('FACE_NOT_DETECTED', 'No face detected. Please look at the camera and try again.');
  }
  if (payload.faceCount !== REQUIRED_FACE_COUNT) {
    reject(
      'INVALID_FACE_COUNT',
      `Exactly one face must be visible for camera check-in (detected: ${payload.faceCount ?? 0}).`,
      { faceCount: payload.faceCount ?? 0 },
    );
  }
  if (payload.latitude == null || payload.longitude == null) {
    reject('LOCATION_REQUIRED', 'GPS location (latitude & longitude) is required for camera check-in.');
  }
  if (payload.accuracy == null || payload.accuracy > MAX_GPS_ACCURACY_METERS) {
    reject(
      'GPS_ACCURACY_TOO_LOW',
      `GPS accuracy must be ${MAX_GPS_ACCURACY_METERS} m or better (reported: ${payload.accuracy ?? 'unknown'} m). Move to an open area and retry.`,
      { gpsAccuracy: payload.accuracy ?? null },
    );
  }
  if (office.lat == null || office.lng == null) {
    reject(
      'OFFICE_LOCATION_NOT_CONFIGURED',
      'The office location has not been configured yet. Please ask your administrator.',
    );
  }

  const point = { latitude: payload.latitude, longitude: payload.longitude };
  const center = { latitude: office.lat, longitude: office.lng };
  const distanceMeters = getDistance(point, center);
  const withinRadius = isPointWithinRadius(point, center, office.radiusMeters);
  if (!withinRadius) {
    reject(
      'OUTSIDE_GEOFENCE',
      `You are ${distanceMeters} m away from the office; check-in is allowed within ${office.radiusMeters} m.`,
      { distanceMeters, radiusMeters: office.radiusMeters },
    );
  }

  return {
    source: 'camera',
    faceDetected: true,
    faceCount: REQUIRED_FACE_COUNT,
    distanceMeters,
    gpsAccuracy: payload.accuracy,
    radiusMeters: office.radiusMeters,
    withinRadius,
    verifiedAt: now,
  };
}
