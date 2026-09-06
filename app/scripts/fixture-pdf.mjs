/*
 * A minimal one-page PDF with a real text layer, written by hand so the smoke
 * test can open a document without any book in the repo (sample_books/ is
 * gitignored for licensing). Two sentences of Helvetica prose is enough: the
 * smoke test only asks whether PDF.js parsed, rasterised and segmented.
 */
import { writeFileSync } from "node:fs";

const LINES = [
  "Blitz reads a page aloud without reflowing it.",
  "This fixture exists so the smoke test can open a document.",
];

export function writeFixturePdf(path) {
  const text = LINES.map((l, i) =>
    `BT /F1 14 Tf 72 ${700 - i * 24} Td (${l.replace(/[()\\]/g, "\\$&")}) Tj ET`,
  ).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  writeFileSync(path, pdf, "latin1");
  return path;
}
