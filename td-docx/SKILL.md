---
name: td-docx
description: Word document creation, editing, and analysis. TRIGGER whenever a .docx or .dotx file is the input or the output — creating reports, memos, letters, or any deliverable requested "as a Word doc"; producing documents with headings, tables of contents, page numbers, tables, or letterheads; reading or extracting content from a .docx; editing existing documents including find-and-replace and inserting images. Trigger on any mention of "Word document", ".docx", ".dotx", or a document deliverable named report/memo/letter/contract. SKIP for PDFs, spreadsheets, presentations, and Google Docs.
metadata:
  author: teradata
  version: "1.0"
---

# DOCX creation, editing, and analysis

A `.docx` is a ZIP archive of XML parts. Pick the approach by task:

| Task | Approach |
|---|---|
| **Create** a new document | Write a Node script using the `docx` npm library — see gotchas below |
| **Edit** an existing document | unzip → edit `word/document.xml` → rezip (docx-js cannot open existing files) |
| **Read** content | `pandoc -t markdown file.docx` |

Script paths are relative to this skill's directory.

## Creating with docx-js — gotchas

You know the docx API; these are the traps:

- **Default page size is A4.** US Letter needs `page: { size: { width: 12240, height: 15840 } }` (DXA units; 1440 = 1 inch).
- **Landscape:** keep portrait dimensions and set `orientation: PageOrientation.LANDSCAPE` — the library swaps them internally.
- **Tables need widths twice:** `columnWidths` on the table AND `width` on every cell, both `WidthType.DXA` (percentage widths break in Google Docs). Column widths must sum to the table width.
- **Cell shading: `ShadingType.CLEAR`** — `SOLID` renders black.
- **Bullets:** a `numbering` config with `LevelFormat.BULLET` — never a literal `•` in text.
- **Never `\n` inside text** — one `Paragraph` per line. `PageBreak` must sit inside a `Paragraph`.
- **`ImageRun` requires `type`** (`"png"`, `"jpg"`, …).
- **Table of contents** only picks up built-in `HeadingLevel.*` headings; custom heading styles need `outlineLevel` or they won't appear.
- **Horizontal rule:** a paragraph bottom border — not a 1-row table.
- **Right-aligned text on the same line / dot leaders:** `PositionalTab` with `PositionalTabAlignment.RIGHT` and `PositionalTabLeader.DOT` — never padding with spaces or dots.

## Editing existing documents

Legacy `.doc` first: `node .skills/td-docx/scripts/office-kit/soffice.js --headless --convert-to docx file.doc`.

```bash
unzip -q doc.docx -d unpacked/
find unpacked -type l -delete                      # strip symlinks — external docx is untrusted
node .skills/td-docx/scripts/merge-runs.js unpacked/               # coalesce fragmented runs so text is findable
# edit unpacked/word/document.xml in place — do NOT reformat or pretty-print
(cd unpacked && rm -f ../out.docx && zip -Xr ../out.docx .)
node .skills/td-docx/scripts/office-kit/validate.js out.docx
```

**Why merge-runs first:** Word splits visually continuous text across many `<w:r>` runs (revision ids, spell-check state), so the phrase you see in the document often does not exist as a contiguous string in the XML — find-and-replace silently misses it. `merge-runs.js` coalesces adjacent identically-formatted runs without changing content or rendering. It also works on a file directly: `node .skills/td-docx/scripts/merge-runs.js doc.docx -o merged.docx`.

When editing the XML:

- Formatting lives in `<w:rPr>` (run) and `<w:pPr>` (paragraph) — copy the neighbor's when inserting new text so it inherits the document's style.
- Text with leading/trailing spaces needs `xml:space="preserve"` on the `<w:t>`.
- Zip from inside the unpacked dir with `rm -f` first, exactly as shown — a wrapping folder or stale parts make the file unopenable.

## QA (required)

Render and look at every page:

```bash
node .skills/td-docx/scripts/office-kit/render.js out.docx qa/
```

Inspect each image: text overflow in table cells, headings orphaned at page bottom, broken numbering, images misplaced or missing, TOC entries present, leftover placeholder text. Then content-check with `pandoc -t markdown out.docx`. After fixes, re-render — images must come from the edited file.

## Delivering the file (required)

Work in the current working directory with plain relative paths (`report.docx`), never `/tmp`. A file on the sandbox filesystem is **not yet delivered to the user** — on the final command after QA passes, declare the finished file in the execution tool's `harvest` parameter (e.g. `harvest: ["report.docx"]`). Only harvested files reach the user as downloadable artifacts.

## Dependencies

npm: `docx`, `jszip`, `fast-xml-parser` · binaries: `pandoc`, LibreOffice (`soffice`), Poppler (`pdftoppm`) — all provided by the runtime image; scripts fail with a named error if one is missing.
