// Table-PDF builder (pdfkit) for server-generated email attachments (e.g.
// the Exits "Send Mail" button) - styled to match the app's own on-screen
// "Export PDF" print report exactly (see the @media print rules for
// #printReport in workforce.css): teal title + gray meta line under a teal
// rule, a fully-bordered table with an uppercase teal header row and
// zebra-striped body rows. The on-screen "Export PDF" buttons themselves
// stay client-side (window.print()) and are untouched by this - this is
// only for a PDF that has to exist as a real file to attach to an email.
const PDFDocument = require('pdfkit');

const PAGE_MARGIN = 28;
const COLOR_TITLE = '#1d5c63';
const COLOR_META = '#5b6169';
const COLOR_BORDER = '#c3ccc8';
const COLOR_HEADER_BG = '#eef0ed';
const COLOR_ZEBRA = '#f7f9f8';
// Matches #printReport tbody tr.print-section-row in workforce.css - the
// Collar section-heading bar the on-screen "Export PDF" report uses.
const COLOR_SECTION_BG = '#1d5c63';
const SECTION_ROW_HEIGHT = 20;

// landscape defaults to true, matching every existing caller (the
// Mediclaim Exits/Additions reports) unchanged - the Doer Management Send
// Mail route passes landscape: false, since the on-screen report it's
// matching (exportEmployeesPdf, "Export PDF") prints portrait: only
// exportPendingConfirmationsPdf calls the client's own printLandscape()
// override (public/workforce.js) - every other on-screen report, including
// this one, just uses plain window.print() at the browser's default
// (portrait) page size.
function buildTablePdfBuffer({ title, subtitle, columns, rows, landscape = true }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', layout: landscape ? 'landscape' : 'portrait' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - PAGE_MARGIN * 2;
    const cellPaddingX = 7;
    const minRowHeight = 22;
    const minColWidth = 34;

    // A plain array is a normal data row; { section: 'White' } is a
    // full-width heading bar (see isSection below); { bold: true, cells:
    // [...] } is a normal data row rendered in bold - a Total/Summary row
    // that stays in the table's own columns instead of a section bar.
    // rowCells() normalizes any row shape down to its plain cell array,
    // for every place that needs to measure or render cell text without
    // caring which shape produced it.
    function rowCells(row) {
      if (Array.isArray(row)) return row;
      if (row && typeof row === 'object' && 'cells' in row) return row.cells;
      return null;
    }

    // Column widths follow each column's own content, the way a real HTML
    // table (table-layout: auto, what #printReport actually is) sizes
    // itself - "Designation"/"Department" naturally end up wider than
    // "Age"/"Gender" instead of every column getting an equal, often too-
    // narrow, share of the page (which broke long words like "DESIGNATION"
    // mid-way onto a second line - not how a real table would ever render).
    const dataRows = rows.map(rowCells).filter(Boolean);
    function widestToken(text, opts) {
      // The widest SINGLE word/token in a cell, not the whole string - used
      // as a hard floor a column's width can never be scaled below, so a
      // short unbroken value like an employee code never gets split mid-
      // word the way natural-width scaling alone could still force (a real
      // table wraps at spaces, never inside a word, when space is short).
      const words = String(text).split(/\s+/).filter(Boolean);
      let max = 0;
      words.forEach((w) => {
        const width = doc.widthOfString(w, opts);
        if (width > max) max = width;
      });
      return max;
    }
    const HEADER_OPTS = { characterSpacing: 0.3 };
    const naturalWidths = [];
    const minWidths = [];
    columns.forEach((col, i) => {
      doc.font('Helvetica-Bold').fontSize(7.5);
      const headerText = String(col).toUpperCase();
      let natural = doc.widthOfString(headerText, HEADER_OPTS);
      let minToken = widestToken(headerText, HEADER_OPTS);
      dataRows.forEach((row) => {
        doc.font('Helvetica').fontSize(8);
        const cellText = String(row[i] == null ? '' : row[i]);
        const w = doc.widthOfString(cellText);
        if (w > natural) natural = w;
        const tokenW = widestToken(cellText);
        if (tokenW > minToken) minToken = tokenW;
      });
      // +2pt safety margin on the floor - a column pinned at EXACTLY its
      // widest word's width is a hairline tie pdfkit's own wrapping still
      // breaks on (kerning/rounding leaves zero slack), wrapping the very
      // word this floor exists to protect.
      naturalWidths.push(Math.max(minColWidth, natural + cellPaddingX * 2));
      minWidths.push(Math.max(minColWidth, minToken + cellPaddingX * 2 + 2));
    });

    // Water-filling allocation: scale every column proportionally to its
    // natural width to exactly fill the page (matching the real table's
    // width: 100%), except no column is ever scaled below its own
    // minWidths floor - any column that would be gets pinned at its floor
    // instead, and the page width left over is re-divided among the rest.
    function allocateColumnWidths(natural, minW, totalWidth) {
      const n = natural.length;
      const widths = new Array(n).fill(null);
      let active = natural.map((_, i) => i);
      let remaining = totalWidth;
      while (active.length) {
        const totalActiveNatural = active.reduce((sum, i) => sum + natural[i], 0);
        const scale = totalActiveNatural > 0 ? remaining / totalActiveNatural : 0;
        const stillActive = [];
        let anyClamped = false;
        active.forEach((i) => {
          const proposed = natural[i] * scale;
          if (proposed < minW[i]) {
            widths[i] = minW[i];
            remaining -= minW[i];
            anyClamped = true;
          } else {
            stillActive.push(i);
          }
        });
        if (!anyClamped) {
          stillActive.forEach((i) => { widths[i] = natural[i] * scale; });
          break;
        }
        active = stillActive;
      }
      // Only reachable if every column's own minWidths already exceeds the
      // page (each got clamped and remaining went negative) - extremely
      // unlikely for this app's real data, but fall back to the floor
      // rather than leaving anything unset.
      for (let i = 0; i < n; i++) {
        if (widths[i] == null) widths[i] = minW[i];
      }
      return widths;
    }

    const colWidths = allocateColumnWidths(naturalWidths, minWidths, pageWidth);
    const colX = [PAGE_MARGIN];
    for (let i = 0; i < colWidths.length; i++) colX.push(colX[i] + colWidths[i]);

    // Row heights are measured from the actual wrapped text, not fixed -
    // matches a real HTML table, where a cell's row just grows to fit
    // whatever text it holds. A fixed height only ever worked by coincidence
    // in landscape (wide columns, short text rarely wrapped) - portrait's
    // narrower columns (used for the "Export PDF" report specifically -
    // see the landscape param above) wrap far more often, and a fixed
    // height would have clipped/overlapped that text instead of the row
    // just growing.
    function measuredRowHeight(cells, font, fontSize, opts) {
      doc.font(font).fontSize(fontSize);
      let maxH = 0;
      cells.forEach((cell, i) => {
        const h = doc.heightOfString(String(cell == null ? '' : cell), Object.assign({ width: colWidths[i] - cellPaddingX * 2 }, opts));
        if (h > maxH) maxH = h;
      });
      return Math.max(minRowHeight, maxH + 12);
    }

    const headerRowHeight = measuredRowHeight(
      columns.map((c) => String(c).toUpperCase()),
      'Helvetica-Bold', 7.5, { characterSpacing: 0.3 }
    );

    function drawHeader() {
      doc.fontSize(16).font('Helvetica-Bold').fillColor(COLOR_TITLE).text(title, PAGE_MARGIN, PAGE_MARGIN);
      doc.fontSize(9).font('Helvetica').fillColor(COLOR_META).text(subtitle, PAGE_MARGIN, PAGE_MARGIN + 20);
      const ruleY = PAGE_MARGIN + 38;
      doc.moveTo(PAGE_MARGIN, ruleY).lineTo(PAGE_MARGIN + pageWidth, ruleY)
        .lineWidth(1.5).strokeColor(COLOR_TITLE).stroke();
      doc.fillColor('#000').lineWidth(0.5);
      return ruleY + 14;
    }

    // Every cell gets a full border on all sides, matching
    // "#printReport th, #printReport td { border: 1px solid #c3ccc8; }".
    function drawGridLines(y, height) {
      doc.strokeColor(COLOR_BORDER).lineWidth(0.5);
      colX.forEach((x) => {
        doc.moveTo(x, y).lineTo(x, y + height).stroke();
      });
      doc.moveTo(PAGE_MARGIN, y).lineTo(PAGE_MARGIN + pageWidth, y).stroke();
      doc.moveTo(PAGE_MARGIN, y + height).lineTo(PAGE_MARGIN + pageWidth, y + height).stroke();
    }

    function drawTableHead(y) {
      doc.rect(PAGE_MARGIN, y, pageWidth, headerRowHeight).fill(COLOR_HEADER_BG);
      drawGridLines(y, headerRowHeight);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(COLOR_TITLE);
      columns.forEach((col, i) => {
        doc.text(String(col).toUpperCase(), colX[i] + cellPaddingX, y + 8, {
          width: colWidths[i] - cellPaddingX * 2,
          characterSpacing: 0.3
        });
      });
      doc.fillColor('#000');
      return y + headerRowHeight;
    }

    let y = drawHeader();
    y = drawTableHead(y);

    const bottomLimit = doc.page.height - PAGE_MARGIN;

    // Alternating zebra shading is keyed off data-row position only, so a
    // section heading in between doesn't shift which rows look striped -
    // matches "#printReport tbody tr:nth-child(even)" counting every <tr>
    // including .print-section-row ones, which is invisible anyway since
    // the section row's own background overrides it.
    let dataRowIndex = 0;
    rows.forEach((row) => {
      const isSection = row && !Array.isArray(row) && typeof row === 'object' && 'section' in row;
      const isBold = row && !Array.isArray(row) && typeof row === 'object' && 'cells' in row && row.bold;
      const cells = rowCells(row);
      const bodyFont = isBold ? 'Helvetica-Bold' : 'Helvetica';
      const thisRowHeight = isSection ? SECTION_ROW_HEIGHT : measuredRowHeight(cells, bodyFont, 8);
      if (y + thisRowHeight > bottomLimit) {
        doc.addPage();
        y = PAGE_MARGIN;
        y = drawTableHead(y);
      }
      if (isSection) {
        doc.rect(PAGE_MARGIN, y, pageWidth, thisRowHeight).fill(COLOR_SECTION_BG);
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff');
        doc.text(String(row.section).toUpperCase(), PAGE_MARGIN + cellPaddingX, y + 6, {
          width: pageWidth - cellPaddingX * 2,
          characterSpacing: 0.4
        });
        doc.fillColor('#000');
        y += thisRowHeight;
        return;
      }
      // nth-child(even) in the CSS (1-indexed) = odd dataRowIndex here (0-indexed).
      if (dataRowIndex % 2 === 1) {
        doc.rect(PAGE_MARGIN, y, pageWidth, thisRowHeight).fill(COLOR_ZEBRA);
      }
      drawGridLines(y, thisRowHeight);
      doc.font(bodyFont).fontSize(8).fillColor('#000');
      cells.forEach((cell, i) => {
        doc.text(String(cell == null ? '' : cell), colX[i] + cellPaddingX, y + 6, {
          width: colWidths[i] - cellPaddingX * 2
        });
      });
      y += thisRowHeight;
      dataRowIndex++;
    });

    doc.end();
  });
}

module.exports = { buildTablePdfBuffer };
