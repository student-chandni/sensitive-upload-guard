// node scripts/make-fixtures.mjs -> ./fixtures (*sensitive* files have the marker)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';

const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures');
fs.mkdirSync(OUT, { recursive: true });
const write = (name, data) => {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log('wrote', name);
};

// text
write('clean-notes.txt', 'Quarterly planning notes\n\nShip the onboarding flow, then revisit pricing.\n');
write(
  'sensitive-notes.txt',
  'Project Falcon - internal\n\nRevenue forecast for Q3 is attached.\nClassification: WALLED_SENSITIVE\nDo not share outside the team.\n',
);
write('sensitive-utf16.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Customer list\r\nWALLED_SENSITIVE\r\n', 'utf16le')]));
write('sensitive-data.csv', 'id,name,label\n1,Acme,public\n2,Globex,WALLED_SENSITIVE\n');

// images
function textImage({ lines, w = 1100, h = 420, bg = '#ffffff', fg = '#111111', font = 'bold 44px sans-serif' }) {
  const c = createCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = fg;
  ctx.font = font;
  lines.forEach((l, i) => ctx.fillText(l, 50, 90 + i * 80));
  return c;
}
const sensitiveLines = ['Board deck - draft v3', 'Label: WALLED_SENSITIVE', 'Internal use only'];
write('sensitive-screenshot.png', textImage({ lines: sensitiveLines }).toBuffer('image/png'));
write('sensitive-darkmode.png', textImage({ lines: sensitiveLines, bg: '#1e1f22', fg: '#e8e8e8' }).toBuffer('image/png'));
write('sensitive-photo.jpg', textImage({ lines: ['Whiteboard photo', 'WALLED_SENSITIVE', 'roadmap 2027'], bg: '#f3efe6', fg: '#24324a', font: '40px serif' }).toBuffer('image/jpeg', 85));
write('clean-screenshot.png', textImage({ lines: ['Team offsite agenda', '10:00 Coffee and intros', '11:00 Roadmap review'] }).toBuffer('image/png'));

// pdfs
function buildPdf(pageContents, extraObjects = []) {
  // pageContents: [{ stream: Buffer, resources: string }]
  const objs = [];
  const add = (body) => {
    objs.push(body);
    return objs.length;
  };
  const catalogId = add(null);
  const pagesId = add(null);
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const eo of extraObjects) eo.id = add(eo.body);
  const pageIds = [];
  for (const pc of pageContents) {
    const deflated = zlib.deflateSync(pc.stream);
    const contentId = add(Buffer.concat([Buffer.from(`<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`), deflated, Buffer.from('\nendstream')]));
    const res = pc.resources(fontId, extraObjects);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources ${res} /Contents ${contentId} 0 R >>`));
  }
  objs[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const chunks = [Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  const offsets = [];
  let pos = chunks[0].length;
  objs.forEach((body, i) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1');
    const piece = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), b, Buffer.from('\nendobj\n')]);
    offsets.push(pos);
    chunks.push(piece);
    pos += piece.length;
  });
  const xref = ['xref', `0 ${objs.length + 1}`, '0000000000 65535 f '].concat(offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `));
  chunks.push(Buffer.from(`${xref.join('\n')}\ntrailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

const textPage = (lines) => ({
  // hex strings so the marker isn't in the raw bytes
  stream: Buffer.from(`BT /F1 16 Tf 72 720 Td 22 TL ${lines.map((l) => `<${Buffer.from(l, 'latin1').toString('hex')}> Tj T*`).join(' ')} ET`),
  resources: (fontId) => `<< /Font << /F1 ${fontId} 0 R >> >>`,
});

write('clean-report.pdf', buildPdf([textPage(['Weekly status report', 'All milestones on track.'])]));
write(
  'sensitive-report.pdf',
  buildPdf([textPage(['Acquisition memo', 'Page one is harmless.']), textPage(['Appendix B', 'Classification: WALLED_SENSITIVE', 'Do not distribute.'])]),
);

// Scanned PDF: the page is a single JPEG with no text layer, so only OCR can find the marker.
const scan = textImage({ lines: ['SCANNED CONTRACT', 'Clause 7: WALLED_SENSITIVE', 'Signed: J. Doe'], w: 1224, h: 600, bg: '#fbfaf5', font: 'bold 52px sans-serif' });
const jpeg = scan.toBuffer('image/jpeg', 90);
const imgObj = {
  body: Buffer.concat([
    Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${scan.width} /Height ${scan.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
    jpeg,
    Buffer.from('\nendstream'),
  ]),
};
write(
  'sensitive-scanned.pdf',
  buildPdf(
    [{ stream: Buffer.from('q 540 265 0 0 36 450 cm 1 0 0 1 0 0 cm Q q 540 0 0 265 36 450 cm /Im1 Do Q'), resources: (_f, extras) => `<< /XObject << /Im1 ${extras[0].id} 0 R >> >>` }],
    [imgObj],
  ),
);

// Not a supported format, used to check pass-through behaviour.
write('clean-archive.bin', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]));
console.log('done ->', OUT);
