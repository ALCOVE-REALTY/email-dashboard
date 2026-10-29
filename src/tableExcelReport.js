// Task 4 (2026-10-29) - the Excel sibling of pdfReport.js's own
// buildTablePdfBuffer: SAME {title, subtitle, columns, rows} shape (a
// plain array is a data row, {section: 'X'} a full-width heading bar,
// {bold: true, cells: [...]} a bold data row - identical to the PDF
// builder's own row shapes) so every "Send Mail" route can build its rows
// ONCE and hand them to whichever builder the owner picked, rather than
// maintaining two different row formats. Unlike the PDF builder (which
// only ever renders pre-formatted display strings), rows here carry their
// REAL typed values - a Date object becomes a native Excel date cell, a
// number a native Excel number cell - never pre-stringified, so Excel's
// own date/number features (sorting, filtering, SUM()) work on the
// downloaded file.
const ExcelJS = require('exceljs');

function isSectionRow(row) {
  return Boolean(row) && typeof row === 'object' && !Array.isArray(row) && 'section' in row;
}
function rowCells(row) {
  if (Array.isArray(row)) return row;
  if (row && typeof row === 'object' && 'cells' in row) return row.cells;
  return null;
}
function displayWidthOf(value) {
  if (value instanceof Date) return value.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).length;
  return String(value === null || value === undefined ? '' : value).length;
}

async function buildTableExcelBuffer({ title, subtitle, columns, rows }) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('Report');
  const colCount = Math.max((columns || []).length, 1);

  if (title) {
    const titleRow = sheet.addRow([title]);
    titleRow.font = { bold: true, size: 14 };
    sheet.mergeCells(titleRow.number, 1, titleRow.number, colCount);
  }
  if (subtitle) {
    const subtitleRow = sheet.addRow([subtitle]);
    subtitleRow.font = { italic: true, color: { argb: 'FF666666' } };
    sheet.mergeCells(subtitleRow.number, 1, subtitleRow.number, colCount);
  }
  if (title || subtitle) sheet.addRow([]);

  const headerRow = sheet.addRow(columns || []);
  headerRow.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
  });

  (rows || []).forEach((row) => {
    if (isSectionRow(row)) {
      const sRow = sheet.addRow([row.section]);
      sRow.font = { bold: true };
      sRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } }; });
      sheet.mergeCells(sRow.number, 1, sRow.number, colCount);
      return;
    }
    const cells = rowCells(row);
    if (!cells) return;
    const excelRow = sheet.addRow(cells);
    cells.forEach((value, i) => {
      const cell = excelRow.getCell(i + 1);
      if (value instanceof Date) {
        cell.value = value;
        cell.numFmt = 'dd-mmm-yyyy';
      } else if (typeof value === 'number') {
        cell.numFmt = Number.isInteger(value) ? '#,##0' : '#,##0.00';
      }
    });
    if (row && typeof row === 'object' && !Array.isArray(row) && row.bold) excelRow.font = { bold: true };
  });

  // Column widths follow each column's own widest real content (header or
  // any row cell, dates/numbers measured by their DISPLAY width) - same
  // "content decides the width" spirit as buildTablePdfBuffer's own
  // natural-width sizing, clamped to a sane range for a mail attachment.
  const widths = (columns || []).map((c) => String(c).length);
  (rows || []).forEach((row) => {
    const cells = rowCells(row);
    if (!cells) return;
    cells.forEach((value, i) => {
      if (i >= widths.length) return;
      widths[i] = Math.max(widths[i], displayWidthOf(value));
    });
  });
  sheet.columns.forEach((col, i) => { col.width = Math.min(Math.max((widths[i] || 8) + 3, 10), 42); });

  return wb.xlsx.writeBuffer();
}

module.exports = { buildTableExcelBuffer };
