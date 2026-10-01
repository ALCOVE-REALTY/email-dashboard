// Reproduces the company's own hardcopy "Interview Assessment Sheet" (the
// paper form candidates/interviewers used to hand-fill) as a real PDF, so
// the Interview Panel dashboard can generate an identical-looking document
// from the data captured through the digital Candidate/Interviewer forms
// instead. Same letterhead logo as letterPdf.js's Increment Letter.
const path = require('path');
const PDFDocument = require('pdfkit');

const LOGO_PATH = path.join(__dirname, 'assets', 'alcove-logo.png');

const PAGE_MARGIN = 28;
const COLOR_INK = '#000000';
const COLOR_BORDER = '#000000';
const COLOR_HEADER_BG = '#e6e6e6';
const COLOR_MARK_BG = '#bfbfbf';

const GRADE_COLUMNS = [
  { key: 'A', label: 'A', sub: 'OUTSTANDING' },
  { key: 'B+', label: 'B+', sub: 'V.GOOD' },
  { key: 'B', label: 'B', sub: 'GOOD' },
  { key: 'C', label: 'C', sub: 'AVERAGE' },
  { key: 'D', label: 'D', sub: 'BELOW AVERAGE' }
];

const COMPETENCIES = [
  { key: 'gradeIntelligence', label: 'Intelligence' },
  { key: 'gradeAttitude', label: 'Attitude' },
  { key: 'gradePersonality', label: 'Personality' },
  { key: 'gradeConfidence', label: 'Confidence' },
  { key: 'gradeCommunicationSkills', label: 'Communication Skills' },
  { key: 'gradeAcademicPerformance', label: 'Academic Performance' },
  { key: 'gradeJobKnowledge', label: 'Job Knowledge' },
  { key: 'gradeJobSuitability', label: 'Job Suitability' }
];

const INTERVIEW_STATUS_OPTIONS = ['Selected', 'Shortlisted', 'Rejected'];

function buildInterviewAssessmentPdf(record) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const contentWidth = doc.page.width - PAGE_MARGIN * 2;
    let y = PAGE_MARGIN;

    // ---------- Letterhead ----------
    try {
      doc.image(LOGO_PATH, PAGE_MARGIN, y, { width: 46 });
    } catch {
      // Missing logo file shouldn't block generating the rest of the PDF.
    }
    doc.font('Helvetica-Bold').fontSize(16).fillColor(COLOR_INK)
      .text('ALCOVE REALTY', PAGE_MARGIN, y + 2, { width: contentWidth, align: 'center' });
    doc.font('Helvetica').fontSize(9)
      .text('Ganapati - 68/2 Harish Mukherjee Road, Kolkata - 700025', PAGE_MARGIN, y + 22, { width: contentWidth, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(12)
      .text('Interview Assessment Sheet', PAGE_MARGIN, y + 36, { width: contentWidth, align: 'center' });
    y += 58;

    // A plain vector tick (two strokes) instead of an 'X' - drawn rather
    // than typed, since the standard Helvetica font pdfkit uses here has no
    // check-mark glyph in its encoding (a literal '✓' character would just
    // render as a missing-glyph box).
    function drawCheckmark(cx, cy, size) {
      doc.save();
      doc.lineWidth(1.3).strokeColor(COLOR_INK).lineCap('round').lineJoin('round');
      doc.moveTo(cx - size * 0.5, cy)
        .lineTo(cx - size * 0.12, cy + size * 0.38)
        .lineTo(cx + size * 0.55, cy - size * 0.42)
        .stroke();
      doc.restore();
    }

    // ---------- Generic bordered-grid helper ----------
    // rows: array of arrays of { text, bold, width (fraction of contentWidth), fill }
    // cell.mark draws a checkmark centered in the whole cell instead of text
    // (the grade grid / NO column); cell.markAfter draws one right after the
    // cell's own text (the Interview Status row's inline "SELECTED ✓").
    function drawGridRow(cells, rowHeight) {
      let x = PAGE_MARGIN;
      doc.lineWidth(0.75).strokeColor(COLOR_BORDER);
      cells.forEach((cell) => {
        const w = cell.width * contentWidth;
        if (cell.fill) doc.rect(x, y, w, rowHeight).fill(cell.fill);
        doc.rect(x, y, w, rowHeight).stroke();
        const font = cell.bold ? 'Helvetica-Bold' : 'Helvetica';
        const fontSize = cell.fontSize || 8;
        doc.fillColor(COLOR_INK).font(font).fontSize(fontSize);
        if (cell.mark) {
          drawCheckmark(x + w / 2, y + rowHeight / 2, 8);
        } else {
          doc.text(cell.text || '', x + 4, y + rowHeight / 2 - fontSize / 2 - 1, {
            width: w - 8,
            align: cell.align || 'left'
          });
          if (cell.markAfter) {
            const textWidth = doc.widthOfString(cell.text || '');
            drawCheckmark(x + 4 + textWidth + 10, y + rowHeight / 2, 8);
          }
        }
        x += w;
      });
      y += rowHeight;
    }

    function checkPageBreak(neededHeight) {
      if (y + neededHeight > doc.page.height - PAGE_MARGIN) {
        doc.addPage();
        y = PAGE_MARGIN;
      }
    }

    // ---------- Candidate info grid (2 label/value pairs per row) ----------
    const infoPairs = [
      ['NAME', record.name, 'CURRENT POSITION', record.currentPosition],
      ['CONTACT NO', record.contactNo, 'POSITION APPLIED FOR', record.positionAppliedFor],
      ['QUALIFICATION', record.qualification, 'INTERVIEW DATE', record.interviewDate],
      ['EXPERIENCE', record.experience, 'INTERVIEW PLACE', record.interviewPlace],
      ['INTERVIEW MODE', record.interviewMode, 'REFERENCE NAME', record.referenceName]
    ];
    infoPairs.forEach(([l1, v1, l2, v2]) => {
      drawGridRow([
        { text: l1, bold: true, width: 0.16, fill: COLOR_HEADER_BG },
        { text: v1, width: 0.34 },
        { text: l2, bold: true, width: 0.16, fill: COLOR_HEADER_BG },
        { text: v2, width: 0.34 }
      ], 20);
    });

    const companyPairs = [
      ['PRESENT/LAST COMPANY', record.presentLastCompany],
      ['DESIGNATION', record.designation],
      ['CURRENT/LAST SALARY DRAWN', record.currentLastSalaryDrawn],
      ['EXPECTED SALARY', record.expectedSalary],
      ['NOTICE PERIOD', record.noticePeriod]
    ];
    companyPairs.forEach(([l, v]) => {
      drawGridRow([
        { text: l, bold: true, width: 0.3, fill: COLOR_HEADER_BG },
        { text: v, width: 0.7 }
      ], 20);
    });

    const workedYes = String(record.workedOnAlcoveProjects || '').toLowerCase() === 'yes';
    drawGridRow([
      { text: 'WORKED ON ANY ALCOVE PROJECTS EARLIER?', bold: true, width: 0.4, fill: COLOR_HEADER_BG },
      { text: 'IF YES', bold: true, width: 0.12, fill: COLOR_HEADER_BG },
      { text: workedYes ? (record.alcoveProjectsDetails || 'Yes') : '', width: 0.28 },
      { text: 'NO', bold: true, width: 0.08, fill: COLOR_HEADER_BG },
      { mark: !workedYes, width: 0.12 }
    ], 22);
    y += 6;

    // ---------- Evaluation grid ----------
    checkPageBreak(24 * 2 + 18 * 9);
    const compLabelWidth = 0.28;
    const gradeColWidth = (1 - compLabelWidth) / GRADE_COLUMNS.length;
    drawGridRow(
      [{ text: 'EVALUATION CRITERION', bold: true, width: compLabelWidth, fill: COLOR_HEADER_BG }].concat(
        GRADE_COLUMNS.map((g) => ({ text: g.label, bold: true, align: 'center', width: gradeColWidth, fill: COLOR_HEADER_BG }))
      ),
      16
    );
    drawGridRow(
      [{ text: 'COMPETENCY', bold: true, width: compLabelWidth, fill: COLOR_HEADER_BG }].concat(
        GRADE_COLUMNS.map((g) => ({ text: g.sub, align: 'center', fontSize: 6.5, width: gradeColWidth, fill: COLOR_HEADER_BG }))
      ),
      16
    );
    COMPETENCIES.forEach((comp) => {
      const selected = record[comp.key];
      drawGridRow(
        [{ text: comp.label, width: compLabelWidth }].concat(
          GRADE_COLUMNS.map((g) => ({
            mark: g.key === selected,
            width: gradeColWidth,
            fill: g.key === selected ? COLOR_MARK_BG : null
          }))
        ),
        18
      );
    });
    drawGridRow(
      [{ text: 'OVERALL GRADE', bold: true, width: compLabelWidth, fill: COLOR_HEADER_BG }].concat(
        GRADE_COLUMNS.map((g) => ({
          mark: g.key === record.overallGrade,
          width: gradeColWidth,
          fill: g.key === record.overallGrade ? COLOR_MARK_BG : COLOR_HEADER_BG
        }))
      ),
      18
    );
    y += 6;

    // ---------- Status ----------
    checkPageBreak(20 + 20 + 50);
    drawGridRow(
      [{ text: 'INTERVIEW STATUS', bold: true, width: 0.22, fill: COLOR_HEADER_BG }].concat(
        INTERVIEW_STATUS_OPTIONS.map((opt) => ({
          text: opt.toUpperCase() + ':',
          markAfter: record.interviewStatus === opt,
          width: 0.26
        }))
      ),
      20
    );
    const isReplacement = record.newRejoinedReplacement === 'Replacement';
    const newRejoinedReplacementText = isReplacement && record.replacementForName
      ? record.newRejoinedReplacement + ' (of ' + record.replacementForName + ')'
      : record.newRejoinedReplacement;
    drawGridRow([
      { text: 'NEW / REJOINED / REPLACEMENT', bold: true, width: 0.3, fill: COLOR_HEADER_BG },
      { text: newRejoinedReplacementText, width: 0.7 }
    ], 20);

    checkPageBreak(60);
    doc.lineWidth(0.75).strokeColor(COLOR_BORDER);
    const commentsHeight = 50;
    doc.rect(PAGE_MARGIN, y, contentWidth, 16).fill(COLOR_HEADER_BG);
    doc.rect(PAGE_MARGIN, y, contentWidth, 16).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_INK).text('INTERVIEWER COMMENTS', PAGE_MARGIN + 4, y + 4);
    y += 16;
    doc.rect(PAGE_MARGIN, y, contentWidth, commentsHeight).stroke();
    doc.font('Helvetica').fontSize(8).text(record.interviewerComments || '', PAGE_MARGIN + 4, y + 4, { width: contentWidth - 8, height: commentsHeight - 8 });
    y += commentsHeight + 6;

    // ---------- Interview Panel List ----------
    checkPageBreak(16 * 4 + 10);
    const panelList = Array.isArray(record.panelList) ? record.panelList.slice(0, 4) : [];
    const panelCols = Math.max(panelList.length, 1);
    const labelW = 0.18;
    const colW = (1 - labelW) / panelCols;
    doc.rect(PAGE_MARGIN, y, contentWidth, 16).fill(COLOR_HEADER_BG);
    doc.rect(PAGE_MARGIN, y, contentWidth, 16).stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(COLOR_INK).text('INTERVIEW PANEL LIST', PAGE_MARGIN + 4, y + 4);
    y += 16;
    [
      ['NAMES', (p) => p.name],
      ['DESIGNATIONS', (p) => p.designation],
      ['DEPARTMENTS', (p) => p.department]
    ].forEach(([label, pick]) => {
      const cells = [{ text: label, bold: true, width: labelW, fill: COLOR_HEADER_BG }];
      for (let i = 0; i < panelCols; i++) {
        cells.push({ text: panelList[i] ? pick(panelList[i]) : '', width: colW });
      }
      drawGridRow(cells, 18);
    });
    y += 6;

    checkPageBreak(20 + 40);
    drawGridRow([
      { text: 'ADDITIONAL NOTE', bold: true, width: 0.3, fill: COLOR_HEADER_BG },
      { text: record.additionalNote, width: 0.7 }
    ], 20);
    y += 24;

    // ---------- Signatures (typed names in place of a pen signature) ----------
    checkPageBreak(30);
    const halfWidth = contentWidth / 2;
    doc.font('Helvetica').fontSize(9).fillColor(COLOR_INK);
    doc.text('SIGNATURE OF INTERVIEWER:', PAGE_MARGIN, y, { width: halfWidth, continued: false });
    doc.font('Helvetica-Bold').text(record.interviewerSignatureName || '________________', PAGE_MARGIN + 150, y);
    doc.font('Helvetica').text('SIGNATURE OF HR DEPT:', PAGE_MARGIN + halfWidth, y);
    doc.font('Helvetica-Bold').text(record.hrSignatureName || '________________', PAGE_MARGIN + halfWidth + 130, y);

    doc.end();
  });
}

module.exports = { buildInterviewAssessmentPdf };
