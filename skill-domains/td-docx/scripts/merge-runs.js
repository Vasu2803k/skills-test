#!/usr/bin/env node
// Coalesce fragmented text runs in word/document.xml so text is findable.
//
// Word splits visually continuous text across many <w:r> runs (revision
// bookkeeping, spell-check state), so a phrase you can read in the document
// often does not exist as a contiguous string in the XML — and your
// find-and-replace silently misses it. This merges adjacent runs whose
// formatting (<w:rPr>) is byte-identical, without changing content or
// rendering.
//
// Only runs containing nothing but optional <w:rPr> plus <w:t> text are
// touched. Runs with drawings, tabs, breaks, fields, or tracked-change
// content are left exactly as they are.
//
// Usage:
//   node merge-runs.js unpacked/            # edits word/document.xml in place
//   node merge-runs.js doc.docx -o out.docx # works on a .docx directly
'use strict';

const fs = require('fs');
const path = require('path');

const RUN_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const T_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t(?:\s[^>]*)?\/>/g;

function parseRun(run) {
  const open = run.match(/^<w:r(\s[^>]*)?>/);
  const inner = run.slice(open[0].length, run.length - '</w:r>'.length);
  const rPrMatch = inner.match(/^(?:<w:rPr(?:\s[^>]*)?\/>|<w:rPr(?:\s[^>]*)?>[\s\S]*?<\/w:rPr>)/);
  const rPr = rPrMatch ? rPrMatch[0] : '';
  const rest = inner.slice(rPr.length);
  const onlyText = /^(?:<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>|<w:t(?:\s[^>]*)?\/>)*$/.test(rest) && rest.length > 0;
  if (!onlyText) return null;
  const text = [...rest.matchAll(T_RE)].map((m) => m[1] ?? '').join('');
  return { attrs: open[1] || '', rPr, text };
}

function mergeRuns(xml) {
  const out = [];
  let cursor = 0;
  let group = null; // { start, end, attrs, rPr, text, count }
  let merged = 0;

  const flush = () => {
    if (!group) return;
    if (group.count > 1) {
      out.push(`<w:r${group.attrs}>${group.rPr}<w:t xml:space="preserve">${group.text}</w:t></w:r>`);
      merged += group.count;
    } else {
      out.push(group.raw);
    }
    group = null;
  };

  for (const m of xml.matchAll(RUN_RE)) {
    const between = xml.slice(cursor, m.index);
    const parsed = parseRun(m[0]);
    const continues = group && between === '' && parsed && parsed.rPr === group.rPr;
    if (!continues) {
      flush();
      if (between) out.push(between);
      cursor = m.index + m[0].length;
      if (parsed) group = { attrs: parsed.attrs, rPr: parsed.rPr, text: parsed.text, count: 1, raw: m[0] };
      else out.push(m[0]);
      continue;
    }
    group.text += parsed.text;
    group.count += 1;
    cursor = m.index + m[0].length;
  }
  flush();
  out.push(xml.slice(cursor));
  return { xml: out.join(''), merged };
}

async function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  const outFlag = args.indexOf('-o');
  const outFile = outFlag !== -1 ? args[outFlag + 1] : null;
  if (!target || !fs.existsSync(target)) {
    console.error('Usage: node merge-runs.js <unpacked-dir | doc.docx> [-o out.docx]');
    process.exit(2);
  }

  if (fs.statSync(target).isDirectory()) {
    const docPath = path.join(target, 'word', 'document.xml');
    const { xml, merged } = mergeRuns(fs.readFileSync(docPath, 'utf8'));
    fs.writeFileSync(docPath, xml);
    console.log(`Merged ${merged} fragmented runs in ${docPath}`);
    return;
  }

  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(target));
  const docXml = await zip.files['word/document.xml'].async('string');
  const { xml, merged } = mergeRuns(docXml);
  zip.file('word/document.xml', xml);
  const dest = outFile || target;
  fs.writeFileSync(dest, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  console.log(`Merged ${merged} fragmented runs -> ${dest}`);
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
