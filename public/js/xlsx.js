// Minimal Excel (.xlsx) writer: several sheets, text, numbers and dates, a bold header row that stays
// visible when scrolling, filters and column widths. Opens in Excel, Google Sheets and Numbers.
import { zip } from './zip.js';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

// Style ids (cellXfs order in STYLES).
const S_HEADER = 1;
const S_DATE = 2;
const S_DATETIME = 3;
const S_WRAP = 4;
const S_DARK = 5;
const S_TITLE = 6;

const STYLES = `${XML}<styleSheet xmlns="${NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd h:mm AM/PM"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FF1E4FD8"/><name val="Calibri"/></font></fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E4FD8"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF000000"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// Control characters are not allowed in XML.
const INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const esc = (s) =>
  String(s).replace(INVALID, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function colName(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Excel stores dates as days since 1899-12-30. */
function serial(y, m, d, hh = 0, mm = 0, ss = 0) {
  return Date.UTC(y, m - 1, d, hh, mm, ss) / 86_400_000 + 25569;
}

/** A calendar date ("2026-09-28"). */
export const xDate = (s) => (s ? { date: s } : null);
/** A moment (ISO timestamp), shown in the device's time zone. */
export const xDateTime = (iso) => (iso ? { datetime: iso } : null);

function cell(ref, value, wrap) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : '';
  if (typeof value === 'object' && value.date) {
    const [y, m, d] = value.date.split('-').map(Number);
    return `<c r="${ref}" s="${S_DATE}"><v>${serial(y, m, d)}</v></c>`;
  }
  if (typeof value === 'object' && value.datetime) {
    const t = new Date(value.datetime);
    if (Number.isNaN(t.getTime())) return '';
    const v = serial(t.getFullYear(), t.getMonth() + 1, t.getDate(), t.getHours(), t.getMinutes(), t.getSeconds());
    return `<c r="${ref}" s="${S_DATETIME}"><v>${v}</v></c>`;
  }
  const style = wrap ? ` s="${S_WRAP}"` : '';
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

function sheetXml({ columns, rows }) {
  const last = `${colName(columns.length - 1)}${rows.length + 1}`;
  const header = columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="${S_HEADER}"><is><t>${esc(c.header)}</t></is></c>`);
  const body = rows.map(
    (row, r) => `<row r="${r + 2}">${row.map((v, i) => cell(`${colName(i)}${r + 2}`, v, columns[i]?.wrap)).join('')}</row>`,
  );
  return `${XML}<worksheet xmlns="${NS}" xmlns:r="${REL_NS}">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('')}</cols>
<sheetData><row r="1">${header.join('')}</row>${body.join('')}</sheetData>
<autoFilter ref="A1:${last}"/>
</worksheet>`;
}

/**
 * «Verificación»: the document's code and link (lines; the first one as a title) and its QR code drawn with black
 * cells, so it can be scanned from the screen or from the printed sheet.
 */
function verifySheetXml({ lines, matrix }) {
  const top = lines.length + 1;
  const size = matrix.length;
  const rows = lines.map((l, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr" s="${i ? 0 : S_TITLE}"><is><t xml:space="preserve">${esc(l)}</t></is></c></row>`);
  for (let r = 0; r < size; r++) {
    const cells = matrix[r].map((dark, c) => (dark ? `<c r="${colName(c + 1)}${top + r + 1}" s="${S_DARK}"/>` : '')).join('');
    rows.push(`<row r="${top + r + 1}" ht="11.25" customHeight="1">${cells}</row>`);
  }
  return `${XML}<worksheet xmlns="${NS}" xmlns:r="${REL_NS}">
<sheetFormatPr defaultRowHeight="15"/>
<cols><col min="1" max="1" width="2" customWidth="1"/><col min="2" max="${size + 1}" width="1.7" customWidth="1"/></cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;
}

const sheetName = (name, i) => (String(name).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || `Hoja${i + 1}`);

/**
 * @param {{ name: string, columns: { header: string, width?: number, wrap?: boolean }[], rows: any[][] }[]} sheets
 * @returns {Blob}
 */
export function buildXlsx(sheets) {
  const names = sheets.map((s, i) => sheetName(s.name, i));
  const files = [
    {
      name: '[Content_Types].xml',
      data: `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `${XML}<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML}<workbook xmlns="${NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews>
<sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
<definedNames>${sheets
        .map((s, i) => {
          if (s.verify) return '';
          const ref = `'${names[i].replace(/'/g, "''")}'!$A$1:$${colName(s.columns.length - 1)}$${s.rows.length + 1}`;
          return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${esc(ref)}</definedName>`;
        })
        .join('')}</definedNames></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${XML}<Relationships xmlns="${PKG_REL_NS}">${names
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${names.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.verify ? verifySheetXml(s.verify) : sheetXml(s) })),
  ];
  return zip(files, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}
