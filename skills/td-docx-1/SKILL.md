---
name: td-docx-1
description: Word document creation, editing, and analysis. TRIGGER whenever a .docx or .dotx file is the input or the output — creating reports, memos, letters, or any deliverable requested "as a Word doc"; producing documents with headings, tables of contents, page numbers, tables, or letterheads; reading or extracting content from a .docx; editing existing documents including find-and-replace and inserting images. Trigger on any mention of "Word document", ".docx", ".dotx", or a document deliverable named report/memo/letter/contract. SKIP for PDFs, spreadsheets, presentations, and Google Docs.
metadata:
  author: teradata
  version: "1.0"
---

# td-docx-1

**Why merge-runs first:** Word splits visually continuous text across many `<w:r>` runs (revision ids, spell-check state), so the phrase you see in the document often does not exist as a contiguous string in the XML — find-and-replace silently misses it. `merge-runs.js` coalesces adjacent identically-formatted runs without changing content or rendering. It also works on a file directly: `node .skills/td-docx/scripts/merge-runs.js doc.docx -o merged.docx`.

When editing the XML:

- Formatting lives in `<w:rPr>` (run) and `<w:pPr>` (paragraph) — copy the neighbor's when inserting new text so it inherits the document's style.
- Text with leading/trailing spaces needs `xml:space="preserve"` on the `<w:t>`.
- Zip from inside the unpacked dir with `rm -f` first, exactly as shown — a wrapping folder or stale parts make the file unopenable.

