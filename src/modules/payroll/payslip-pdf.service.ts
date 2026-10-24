import { Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import PDFDocument from 'pdfkit';
import { monthLabel } from '../../common/utils/date.util.js';
import type { PayslipDocument } from './schemas/payslip.schema.js';

const BRAND = '#1E3A8A';
const TEXT = '#111827';
const MUTED = '#6B7280';
const SHADE = '#F3F4F6';
const ROW_HEIGHT = 18;

const numberFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Renders a payslip as a streamed A4 PDF (pdfkit, built-in Helvetica — no font files needed). */
@Injectable()
export class PayslipPdfService {
  render(payslip: PayslipDocument, companyName: string, timezone = 'UTC'): PDFKit.PDFDocument {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 50,
      info: {
        Title: `Payslip ${payslip.month} - ${payslip.employee.code}`,
        Author: companyName,
        Subject: `Payslip for ${monthLabel(payslip.month)}`,
      },
    });

    const pageWidth = doc.page.width;
    const left = 50;
    const contentWidth = pageWidth - 100;
    const money = (value: number) => `${payslip.currency} ${numberFormat.format(value)}`;
    const days = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
    let y = 0;

    // ── Header ─────────────────────────────────────────
    doc.rect(0, 0, pageWidth, 100).fill(BRAND);
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(20).text(companyName, left, 30, {
      width: contentWidth,
      lineBreak: false,
    });
    doc.font('Helvetica').fontSize(11).text(`Payslip — ${monthLabel(payslip.month)}`, left, 62, { lineBreak: false });
    doc
      .font('Helvetica-Bold')
      .fontSize(10)
      .text(payslip.status === 'finalized' ? 'FINALIZED' : 'DRAFT', left, 64, {
        width: contentWidth,
        align: 'right',
        lineBreak: false,
      });

    if (payslip.status !== 'finalized') {
      doc.save();
      doc.rotate(-35, { origin: [pageWidth / 2, 430] });
      doc.font('Helvetica-Bold').fontSize(110).fillColor('#DC2626').fillOpacity(0.08);
      doc.text('DRAFT', 0, 370, { width: pageWidth, align: 'center', lineBreak: false });
      doc.restore();
      doc.fillOpacity(1);
    }

    const sectionTitle = (title: string) => {
      y += 10;
      doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), left, y, { lineBreak: false });
      y += 16;
      doc.moveTo(left, y).lineTo(left + contentWidth, y).lineWidth(0.8).strokeColor(BRAND).stroke();
      y += 8;
    };

    const row = (label: string, value: string, options: { bold?: boolean; shade?: boolean } = {}) => {
      if (options.shade) doc.rect(left, y - 4, contentWidth, ROW_HEIGHT).fill(SHADE);
      doc.fillColor(TEXT).font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      doc.text(label, left + 8, y, { width: contentWidth * 0.62, lineBreak: false });
      doc.text(value, left, y, { width: contentWidth - 8, align: 'right', lineBreak: false });
      y += ROW_HEIGHT;
    };

    const detail = (label: string, value: string, x: number, rowY: number) => {
      doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(label.toUpperCase(), x, rowY, { lineBreak: false });
      doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(10).text(value || '—', x, rowY + 10, {
        width: contentWidth / 2 - 10,
        lineBreak: false,
      });
    };

    // ── Employee details ───────────────────────────────
    y = 115;
    sectionTitle('Employee details');
    const e = payslip.employee;
    const rightCol = left + contentWidth / 2;
    detail('Employee code', e.code, left, y);
    detail('Department', e.departmentName, rightCol, y);
    y += 28;
    detail('Name', e.fullName, left, y);
    detail('Designation', e.designationName, rightCol, y);
    y += 28;
    detail('Email', e.email, left, y);
    detail('Join date', e.joinDate + (e.exitDate ? `  (exit: ${e.exitDate})` : ''), rightCol, y);
    y += 30;

    // ── Earnings ───────────────────────────────────────
    sectionTitle('Earnings');
    row('Basic salary', money(payslip.basic));
    row('House rent allowance (40% of basic)', money(payslip.hra), { shade: true });
    row('Medical allowance (10% of basic)', money(payslip.medical));
    row('Gross salary', money(payslip.gross), { bold: true, shade: true });
    row(
      `Prorated gross (${payslip.eligibleWorkingDays} of ${payslip.workingDaysInMonth} working days)`,
      money(payslip.proratedGross),
      { bold: true },
    );

    // ── Attendance deductions ──────────────────────────
    sectionTitle('Attendance deductions');
    row('Absent days', days(payslip.absentDays));
    row('Unpaid leave days', days(payslip.unpaidLeaveDays), { shade: true });
    row('Half days (counted as 0.5 day each)', days(payslip.halfDays));
    row(
      `Late arrivals${payslip.latePenaltyDays ? ` (penalty: ${days(payslip.latePenaltyDays)} day)` : ''}`,
      days(payslip.lateCount),
      { shade: true },
    );
    row('Total deduction days', days(payslip.deductionDays), { bold: true });
    row('Per-day rate (gross / working days)', money(payslip.perDay), { shade: true });
    row('Attendance deduction', `- ${money(payslip.attendanceDeduction)}`, { bold: true });

    // ── Tax ────────────────────────────────────────────
    sectionTitle('Income tax');
    row('Annual gross (gross × 12)', money(payslip.annualGross));
    row('Annual tax (slab based)', money(payslip.annualTax), { shade: true });
    row('Monthly tax deduction', `- ${money(payslip.monthlyTax)}`, { bold: true });

    // ── Net pay ────────────────────────────────────────
    y += 14;
    doc.rect(left, y, contentWidth, 46).fill('#ECFDF5');
    doc.rect(left, y, 4, 46).fill('#059669');
    doc.fillColor('#065F46').font('Helvetica-Bold').fontSize(12).text('NET PAY', left + 16, y + 16, { lineBreak: false });
    doc.fontSize(16).text(money(payslip.netPay), left, y + 13, {
      width: contentWidth - 16,
      align: 'right',
      lineBreak: false,
    });
    y += 60;
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(8)
      .text('Net pay = prorated gross - attendance deduction - monthly tax', left, y, {
        width: contentWidth,
        align: 'center',
        lineBreak: false,
      });

    // ── Footer ─────────────────────────────────────────
    doc
      .fillColor(MUTED)
      .fontSize(8)
      .text(
        `This is a system-generated payslip and does not require a signature. Generated ${DateTime.now()
          .setZone(timezone)
          .toFormat('dd LLL yyyy, HH:mm')} (${timezone}).`,
        left,
        doc.page.height - 90,
        { width: contentWidth, align: 'center', lineBreak: false },
      );

    doc.end();
    return doc;
  }
}
