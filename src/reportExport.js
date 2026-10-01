// Generic exporter for an ad-hoc HR Assistant report (whatever a chat
// card happened to contain - label/value rows or a multi-column table),
// in whichever of the 3 formats the person asked for. Deliberately takes
// no tool-specific knowledge: it only ever sees {title, scope, columns,
// rows, total, totalLabel} - the same shape View Report renders in the
// browser - so the downloaded file is guaranteed to match what was shown
// on screen, not a separately-computed report.
const { buildTablePdfBuffer } = require('./pdfReport');
const ExcelJS = require('exceljs');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel, WidthType } = require('docx');

const GENERATED_LABEL = () =>
  'Generated ' + new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
  ', ' + new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

function normalizeReport(payload) {
  const columns = Array.isArray(payload.columns) && payload.columns.length ? payload.columns : ['Item', 'Value'];
  const rows = Array.isArray(payload.tableRows)
    ? payload.tableRows
    : Array.isArray(payload.rows)
      ? payload.rows.map((r) => [r.label, r.value])
      : [];
  const cellText = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
  return {
    title: payload.title || 'Report',
    scope: payload.scope || '',
    columns,
    rows: rows.map((r) => r.map(cellText)),
    total: payload.total,
    totalLabel: payload.totalLabel || 'Total'
  };
}

function totalRowCells(columns, totalLabel, total) {
  return columns.map((_, i) => (i === 0 ? totalLabel : i === 1 ? String(total) : ''));
}

async function buildReportPdf(payload) {
  const { title, scope, columns, rows, total, totalLabel } = normalizeReport(payload);
  const tableRows = total === undefined || total === null
    ? rows
    : rows.concat([{ bold: true, cells: totalRowCells(columns, totalLabel, total) }]);
  return buildTablePdfBuffer({
    title,
    subtitle: (scope ? scope + ' · ' : '') + GENERATED_LABEL(),
    columns,
    rows: tableRows.length ? tableRows : [columns.map(() => '—')],
    landscape: columns.length > 3
  });
}

async function buildReportExcel(payload) {
  const { title, scope, columns, rows, total, totalLabel } = normalizeReport(payload);
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Report');
  sheet.addRow([title]).font = { bold: true, size: 14 };
  if (scope) sheet.addRow([scope]);
  sheet.addRow([GENERATED_LABEL()]);
  sheet.addRow([]);
  const headerRow = sheet.addRow(columns);
  headerRow.font = { bold: true };
  rows.forEach((r) => sheet.addRow(r));
  if (total !== undefined && total !== null) {
    sheet.addRow(totalRowCells(columns, totalLabel, total)).font = { bold: true };
  }
  sheet.columns.forEach((col) => {
    col.width = 24;
  });
  return wb.xlsx.writeBuffer();
}

async function buildReportWord(payload) {
  const { title, scope, columns, rows, total, totalLabel } = normalizeReport(payload);
  const cell = (text, bold) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text, bold: Boolean(bold) })] })] });
  const headerRow = new TableRow({ children: columns.map((c) => cell(c, true)) });
  const bodyRows = rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }));
  const allRows = [headerRow].concat(bodyRows);
  if (total !== undefined && total !== null) {
    allRows.push(new TableRow({ children: totalRowCells(columns, totalLabel, total).map((c) => cell(c, true)) }));
  }
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
          ...(scope ? [new Paragraph({ children: [new TextRun({ text: scope, italics: true })] })] : []),
          new Paragraph({ children: [new TextRun({ text: GENERATED_LABEL(), italics: true })] }),
          new Paragraph({ text: '' }),
          new Table({ rows: allRows, width: { size: 100, type: WidthType.PERCENTAGE } })
        ]
      }
    ]
  });
  return Packer.toBuffer(doc);
}

module.exports = { buildReportPdf, buildReportExcel, buildReportWord };
