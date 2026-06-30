/**
 * Generates a minimal valid PDF at fixtures/sample.pdf.
 * Run once: node tests/e2e/fixtures/generate-test-pdf.mjs
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// A minimal single-page PDF containing "软考架构师测试文档"
const PDF_CONTENT = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj

2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj

3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]
   /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>
endobj

4 0 obj
<< /Length 120 >>
stream
BT
/F1 16 Tf
72 770 Td
(SoftExam Architect Test Document) Tj
0 -30 Td
(Chapter 1: Software Architecture) Tj
0 -30 Td
(Chapter 2: Design Patterns) Tj
ET
endstream
endobj

5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj

xref
0 6
0000000000 65535 f
0000000009 00000 n
0000000058 00000 n
0000000115 00000 n
0000000266 00000 n
0000000436 00000 n

trailer
<< /Size 6 /Root 1 0 R >>
startxref
515
%%EOF`

const outPath = path.join(__dirname, 'sample.pdf')
fs.writeFileSync(outPath, PDF_CONTENT, 'latin1')
console.log('Generated:', outPath)
