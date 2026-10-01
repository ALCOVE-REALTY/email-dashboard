// Increment Letter PDF - reproduces the company's own finalized Word
// template (Increment Letter- Rajeev Tiwari.docx) exactly: same page size/
// margins, same logo, same body copy and bold placement, same footer.
// Cambria (the template's body font) is a proprietary Microsoft font that
// can't be redistributed/bundled into this deployment, so Times-Roman/
// Times-Bold (pdfkit's built-in core fonts, same serif family) stand in
// for it - everything else here is pulled directly from the template's
// own XML (fonts, sizes, margins, colors, bold/underline placement).
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, 'assets', 'alcove-logo.png');

// Converted from the template's own w:pgMar (twips / 20 = points). Bottom
// is deliberately NOT the template's real 56.7 - pdfkit forces a page break
// on ANY text (even absolutely-positioned) that would extend past
// page.height - margins.bottom, which would otherwise push the footer (it
// sits further down than that, in the true bottom margin area Word reserves
// for footers) onto an unwanted second page. Kept small instead, since nothing
// here relies on pdfkit's own auto-pagination in the first place.
const MARGIN_TOP = 119.9;
const MARGIN_BOTTOM = 10;
const MARGIN_LEFT = 49.6;
const MARGIN_RIGHT = 42.55;

const BODY_FONT = 'Times-Roman';
const BODY_FONT_BOLD = 'Times-Bold';
const BODY_FONT_ITALIC = 'Times-Italic';
const BODY_SIZE = 11.5;

function ddmmyyyy(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return d + '-' + m + '-' + y;
}

// Mixed bold/plain run within one flowing (wrapping) paragraph.
function writeMixed(doc, segments) {
  segments.forEach((seg, i) => {
    doc.font(seg.bold ? BODY_FONT_BOLD : BODY_FONT).fontSize(BODY_SIZE);
    const opts = { continued: i < segments.length - 1 };
    if (seg.underline) opts.underline = true;
    doc.text(seg.text, opts);
  });
}

// The notice-period clause is only meaningful when both halves of it are
// actually set - if HR leaves that section on "Select" (either or both),
// just the "& accordingly...instead of X" part is left out; "effective
// from <date>" still closes the sentence either way.
function revisedCompSegments({ currentGrossText, revisedGrossText, currentNotice, revisedNotice, dateStr }) {
  const segments = [
    { text: currentGrossText, bold: true },
    { text: ' to ' },
    { text: revisedGrossText, bold: true }
  ];
  if (currentNotice && revisedNotice) {
    segments.push(
      { text: ' & accordingly your notice period has been revised to ' },
      { text: revisedNotice, bold: true },
      { text: ' instead of ' + currentNotice + ', effective from ' + dateStr + '.' }
    );
  } else {
    segments.push({ text: ', effective from ' + dateStr + '.' });
  }
  return segments;
}

// Same idea for "Eligible for next Increment" - left on "Select", the
// entire sentence (not just the year) is omitted.
function drawIncrementYearParagraph(doc, incrementYear) {
  if (!incrementYear) return;
  writeMixed(doc, [
    { text: 'You shall be eligible for your next increment in ' },
    { text: incrementYear, bold: true },
    { text: ', as per company policy.' }
  ]);
  doc.moveDown(1.2);
}

// Shared by both letters - identical wording/spacing in both templates,
// only the signing company name changes.
function drawClosing(doc, companyName) {
  doc.font(BODY_FONT).fontSize(BODY_SIZE)
    .text('We are confident that you will bring the same high level of professionalism and hard work to the role assigned to you.');
  doc.moveDown(1.2);

  doc.text('We hope that you will continue to put in your best efforts with greater zeal and enthusiasm during the ensuing year too.');
  doc.moveDown(1.2);

  doc.text('Wish you a rewarding career with us.');
  doc.moveDown(2.5);

  writeMixed(doc, [{ text: 'For ' }, { text: companyName, bold: true }]);
  // Wider gap - room for an actual pen signature between the company
  // name and "(Authorized Signatory)".
  doc.moveDown(6);

  doc.font(BODY_FONT_ITALIC).fontSize(BODY_SIZE).text('(Authorized Signatory)');
}

// Footer - centered, Helvetica, same fixed address/contact block for every
// company (only the company name itself changes). The Promotion &
// Increment template's footer includes an "(LLPIN: AAC - 2250)" suffix
// the Increment Letter's own footer doesn't have - a real difference
// between the two templates, not an inconsistency to "fix".
function drawFooter(doc, companyName, bodyWidth, includeLLPIN) {
  const footerY = doc.page.height - 42;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#0070C0')
    .text(companyName, MARGIN_LEFT, footerY, { width: bodyWidth, align: 'center' });
  doc.fillColor('#000').fontSize(7).font('Helvetica')
    .text(
      'Ganapati, 68/2 Harish Mukherjee Road, Kolkata -700025  P +91 33 6684 2100  F +91 2455 7052  ' +
      'E hr@alcoverealty.in  W alcoverealty.in' + (includeLLPIN ? '  (LLPIN: AAC - 2250)' : ''),
      MARGIN_LEFT, footerY + 12, { width: bodyWidth, align: 'center' }
    );
}

function buildIncrementLetterPdf(fields) {
  const {
    title, employeeName, employeeId, department, companyName, refNo,
    currentDesignation, currentGross, revisedGross, currentNotice, revisedNotice,
    effectiveDate, incrementYear
  } = fields;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_LEFT, right: MARGIN_RIGHT }
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const bodyWidth = doc.page.width - MARGIN_LEFT - MARGIN_RIGHT;
    const dateStr = ddmmyyyy(effectiveDate);

    // Logo - same size/position as the template's header (inline, left-
    // aligned, slightly left of the body's own left margin).
    doc.image(LOGO_PATH, 28, 21.25, { width: 110.25, height: 56.9 });

    doc.y = MARGIN_TOP;

    // Ref. No. / Date - one line, left part + right-aligned part. Combining
    // an align:'right' box with a continued chain garbles the two runs
    // together (pdfkit bug/quirk), so the right-aligned x is computed by
    // hand instead of relying on that combination.
    const refLineY = doc.y;
    doc.font(BODY_FONT).fontSize(BODY_SIZE).fillColor('#000')
      .text('Ref. No: AR/HR/Inc./' + refNo, MARGIN_LEFT, refLineY);
    const dateLabel = 'Date: ';
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE);
    const dateLabelWidth = doc.widthOfString(dateLabel);
    doc.font(BODY_FONT).fontSize(BODY_SIZE);
    const dateValueWidth = doc.widthOfString(dateStr);
    const dateStartX = MARGIN_LEFT + bodyWidth - dateLabelWidth - dateValueWidth;
    doc.font(BODY_FONT_BOLD).text(dateLabel, dateStartX, refLineY, { continued: true, lineBreak: false });
    doc.font(BODY_FONT).text(dateStr, { lineBreak: false });
    // The positioned call above leaves doc.x wherever that line ended (near
    // the right margin) - every subsequent plain .text() call has no
    // explicit x, so without this reset they'd all inherit that leftover x
    // and word-wrap into a near-zero-width column.
    doc.x = MARGIN_LEFT;
    doc.y = refLineY + doc.currentLineHeight() + 2;
    doc.moveDown(2);

    // Recipient block.
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE);
    doc.text(title + ' ' + employeeName);
    doc.text('Emp ID: ' + employeeId);
    doc.text('Department: ' + department);
    doc.moveDown(1.5);

    // Subject - centered, bold, underlined.
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE).text('SUB: - Increment letter', { align: 'center', underline: true });
    // Extra gap here (vs. the other section gaps) - the page had a lot of
    // unused space at the bottom, so the rest of the letter is pushed down
    // rather than sitting bunched up at the top.
    doc.moveDown(3.5);

    // Salutation.
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE).text('Dear ' + title + ' ' + employeeName + ',');
    doc.moveDown(1.2);

    writeMixed(doc, [
      { text: 'We are pleased to inform you that your current designation is ' },
      { text: currentDesignation + '.', bold: true }
    ]);
    doc.moveDown(1.2);

    writeMixed(doc, [
      {
        text:
          'Congratulations on this well-deserved increment. We take this opportunity to congratulate you and ' +
          'express our appreciation for your valuable contribution to achieving company objectives. Specific ' +
          'terms relating to your monthly gross remuneration have been revised from '
      },
      ...revisedCompSegments({
        currentGrossText: 'Rs. ' + currentGross + ' /-',
        revisedGrossText: 'Rs. ' + revisedGross + '/-',
        currentNotice,
        revisedNotice,
        dateStr
      })
    ]);
    doc.moveDown(1.2);

    drawIncrementYearParagraph(doc, incrementYear);

    drawClosing(doc, companyName);
    drawFooter(doc, companyName, bodyWidth, false);

    doc.end();
  });
}

// Promotion & Increment Letter PDF - reproduces the company's own
// finalized Word template (Promotion & Increment Letter- Dwiptesh Dey.docx)
// exactly. Differs from the plain Increment Letter in a few real ways (not
// inconsistencies to reconcile): Date and Ref. No. sit on their own separate
// lines instead of sharing one, the template's own top margin is smaller, the
// designation change itself is stated as part of the letter (from/to, both
// bold) ahead of the same notice-period clause the Increment Letter has, and
// the footer carries an extra "(LLPIN: AAC - 2250)" suffix.
const PROMO_MARGIN_TOP = 92.15; // this template's own w:pgMar top (1843 twips / 20)

function buildPromotionIncrementLetterPdf(fields) {
  const {
    title, employeeName, employeeId, department, companyName, refNo,
    fromDesignation, toDesignation, currentGross, revisedGross,
    currentNotice, revisedNotice, effectiveDate, incrementYear
  } = fields;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: PROMO_MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_LEFT, right: MARGIN_RIGHT }
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const bodyWidth = doc.page.width - MARGIN_LEFT - MARGIN_RIGHT;
    const dateStr = ddmmyyyy(effectiveDate);

    // Logo - identical size/position to the Increment Letter's own header.
    doc.image(LOGO_PATH, 28, 21.25, { width: 110.25, height: 56.9 });

    doc.y = PROMO_MARGIN_TOP;
    doc.moveDown(1);

    // Date - its own right-aligned line (unlike the Increment Letter,
    // nothing shares this line with it). Combining an align:'right' box
    // with a continued chain garbles the two runs together (pdfkit bug/
    // quirk), so the right-aligned x is computed by hand instead.
    const dateLineY = doc.y;
    const dateLabel = 'Date: ';
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE).fillColor('#000');
    const dateLabelWidth = doc.widthOfString(dateLabel);
    doc.font(BODY_FONT).fontSize(BODY_SIZE);
    const dateValueWidth = doc.widthOfString(dateStr);
    const dateStartX = MARGIN_LEFT + bodyWidth - dateLabelWidth - dateValueWidth;
    doc.font(BODY_FONT_BOLD).text(dateLabel, dateStartX, dateLineY, { continued: true, lineBreak: false });
    doc.font(BODY_FONT).text(dateStr, { lineBreak: false });
    // The positioned call above leaves doc.x wherever that line ended (near
    // the right margin) - every subsequent plain .text() call has no
    // explicit x, so without this reset they'd all inherit that leftover x
    // and word-wrap into a near-zero-width column.
    doc.x = MARGIN_LEFT;
    doc.y = dateLineY + doc.currentLineHeight() + 2;
    doc.moveDown(1.2);

    // Ref. No. - its own left-aligned line.
    doc.font(BODY_FONT).text('Ref. No: AR/HR/Pro./' + refNo);
    doc.moveDown(1.5);

    // Recipient block.
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE);
    doc.text(title + ' ' + employeeName);
    doc.text('Emp ID: ' + employeeId);
    doc.text('Department: ' + department);
    doc.moveDown(1.5);

    // Subject - centered, bold, underlined.
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE).text('SUB: - Promotion & Increment letter', { align: 'center', underline: true });
    doc.moveDown(3.5);

    // Salutation.
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE).text('Dear ' + title + ' ' + employeeName + ',');
    doc.moveDown(1.2);

    writeMixed(doc, [
      { text: 'We are pleased to inform you that you have been promoted from ' },
      { text: fromDesignation, bold: true },
      { text: ' to ' },
      { text: toDesignation, bold: true },
      { text: ', effective from ' + dateStr + '.' }
    ]);
    doc.moveDown(1.2);

    writeMixed(doc, [
      {
        text:
          'Congratulations on this well-deserved promotion. We take this opportunity to congratulate you and ' +
          'express our appreciation for your valuable contribution to achieving company objectives. Specific ' +
          'terms relating to your monthly gross remuneration have been revised from '
      },
      ...revisedCompSegments({
        currentGrossText: 'Rs. ' + currentGross + '/-',
        revisedGrossText: 'Rs. ' + revisedGross + '/-',
        currentNotice,
        revisedNotice,
        dateStr
      })
    ]);
    doc.moveDown(1.2);

    drawIncrementYearParagraph(doc, incrementYear);

    drawClosing(doc, companyName);
    drawFooter(doc, companyName, bodyWidth, true);

    doc.end();
  });
}

// Confirmation Letter PDF - reproduces the company's own Confirmation
// Letter template exactly. Same header layout as the Increment Letter
// (Ref. No. and Date sharing one line, same top margin), but its own body:
// a "Position:" recipient line instead of "Department:", a plain centered
// "CONFIRMATION LETTER" title (not a "SUB: -" line), a single reference-
// to-the-Appointment-Letter paragraph instead of the increment/promotion
// wording, and a shorter one-sentence closing before "Wish you a
// rewarding career with us." (the template has no "We are confident..."
// paragraph the other two letters both open their closing with).
function buildConfirmationLetterPdf(fields) {
  const { title, employeeName, employeeId, companyName, refNo, position, doj, confirmationDate } = fields;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_LEFT, right: MARGIN_RIGHT }
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const bodyWidth = doc.page.width - MARGIN_LEFT - MARGIN_RIGHT;
    const dojStr = ddmmyyyy(doj);
    const confirmationDateStr = ddmmyyyy(confirmationDate);

    // Logo - same size/position as the Increment Letter's own header.
    doc.image(LOGO_PATH, 28, 21.25, { width: 110.25, height: 56.9 });

    doc.y = MARGIN_TOP;

    // Ref. No. / Date - one shared line, same layout as the Increment
    // Letter (unlike Promotion & Increment's separate lines).
    const refLineY = doc.y;
    doc.font(BODY_FONT).fontSize(BODY_SIZE).fillColor('#000')
      .text('Ref. No: AR/HR/Conf./' + refNo, MARGIN_LEFT, refLineY);
    const dateLabel = 'Date: ';
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE);
    const dateLabelWidth = doc.widthOfString(dateLabel);
    doc.font(BODY_FONT).fontSize(BODY_SIZE);
    const dateValueWidth = doc.widthOfString(confirmationDateStr);
    const dateStartX = MARGIN_LEFT + bodyWidth - dateLabelWidth - dateValueWidth;
    doc.font(BODY_FONT_BOLD).text(dateLabel, dateStartX, refLineY, { continued: true, lineBreak: false });
    doc.font(BODY_FONT).text(confirmationDateStr, { lineBreak: false });
    // The positioned call above leaves doc.x wherever that line ended (near
    // the right margin) - every subsequent plain .text() call has no
    // explicit x, so without this reset they'd all inherit that leftover x
    // and word-wrap into a near-zero-width column.
    doc.x = MARGIN_LEFT;
    doc.y = refLineY + doc.currentLineHeight() + 2;
    doc.moveDown(2);

    // Recipient block - "Position:", not "Department:" (this template has
    // no department line at all).
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE);
    doc.text(title + ' ' + employeeName);
    doc.text('Emp ID: ' + employeeId);
    doc.text('Position: ' + position);
    doc.moveDown(1.5);

    // Title - centered, bold, underlined; a direct title, not a "SUB: -" line.
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE).text('CONFIRMATION LETTER', { align: 'center', underline: true });
    doc.moveDown(3.5);

    // Salutation.
    doc.font(BODY_FONT_BOLD).fontSize(BODY_SIZE).text('Dear ' + title + ' ' + employeeName + ',');
    doc.moveDown(1.2);

    writeMixed(doc, [
      { text: 'In reference to your Appointment Letter date ' },
      { text: dojStr, bold: true },
      {
        text:
          ', the Management is pleased to inform you that you have successfully completed the probation ' +
          'period and your services are being confirmed as '
      },
      { text: position, bold: true },
      { text: ' with effect from ' },
      { text: confirmationDateStr, bold: true },
      { text: '. All the terms and conditions remain same as mentioned in the aforesaid Appointment Letter.' }
    ]);
    doc.moveDown(1.2);

    // Shorter closing than Increment/Promotion's drawClosing - this
    // template has no "We are confident..." paragraph, just these two
    // sentences before the signature block.
    doc.font(BODY_FONT).fontSize(BODY_SIZE)
      .text('We hope that you will continue to put in your efforts with greater zeal and enthusiasm during the ensuing year too.');
    doc.moveDown(1.2);

    doc.text('Wish you a rewarding career with us.');
    doc.moveDown(2.5);

    writeMixed(doc, [{ text: 'For ' }, { text: companyName, bold: true }]);
    // Wider gap - room for an actual pen signature between the company
    // name and "(Authorized Signatory)".
    doc.moveDown(6);

    doc.font(BODY_FONT_ITALIC).fontSize(BODY_SIZE).text('(Authorized Signatory)');

    drawFooter(doc, companyName, bodyWidth, false);

    doc.end();
  });
}

module.exports = { buildIncrementLetterPdf, buildPromotionIncrementLetterPdf, buildConfirmationLetterPdf };
