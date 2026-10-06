#!/usr/bin/env node
// Validate an OOXML package (.pptx/.docx/.xlsx and their template variants)
// at the level Office actually enforces: package structure, relationship
// integrity, content-type coverage, XML well-formedness, plus the known
// generator faults that corrupt files (chart checks for pptx).
//
// This is deliberately not XSD validation — the failures that make Office
// refuse a generated file are almost always structural (a part missing from
// [Content_Types].xml, a dangling relationship, malformed XML, a chart
// referencing an undeclared axis), and those are checked exactly here.
//
// Usage: node validate.js <file.pptx|docx|xlsx> [--smoke]
//   --smoke   also convert the file to PDF with LibreOffice as an
//             open-succeeds smoke test (slower)
//
// Every failure names its fix. Exit 0 = clean, 1 = errors found.
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { XMLValidator } = require('fast-xml-parser');

const errors = [];
const warnings = [];
const err = (msg, fix) => errors.push(`ERROR: ${msg}\n  FIX: ${fix}`);
const warn = (msg) => warnings.push(`WARN: ${msg}`);

function resolveTarget(relsPath, target) {
  // a/b/_rels/c.xml.rels holds relationships whose relative targets resolve
  // against a/b. Absolute targets ("/ppt/...") resolve against the root.
  if (target.startsWith('/')) return target.slice(1);
  const base = path.posix.dirname(path.posix.dirname(relsPath));
  return path.posix.normalize(path.posix.join(base === '.' ? '' : base, target));
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  const smoke = argv.includes('--smoke');
  if (!file) {
    console.error('Usage: node validate.js <file.pptx|docx|xlsx> [--smoke]');
    process.exit(2);
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(fs.readFileSync(file));
  } catch (e) {
    err(`${file} is not a readable ZIP archive (${e.message})`, 'Rebuild the package; if you zipped by hand, zip from INSIDE the unpacked dir so part paths have no leading folder.');
    return finish();
  }

  const parts = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const read = (p) => zip.files[p].async('string');

  // --- [Content_Types].xml coverage ---
  const ctPath = '[Content_Types].xml';
  if (!parts.includes(ctPath)) {
    err('[Content_Types].xml is missing', 'The package must contain [Content_Types].xml at the root; rebuild rather than hand-assembling the zip.');
    return finish();
  }
  const ct = await read(ctPath);
  const defaults = new Set([...ct.matchAll(/<Default[^>]*Extension="([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const overrides = new Set([...ct.matchAll(/<Override[^>]*PartName="([^"]+)"/g)].map((m) => m[1]));
  for (const p of parts) {
    if (p === ctPath) continue;
    // Not path.extname: OPC part names like _rels/.rels are dotfiles to it,
    // but their content-type extension is "rels".
    const base = p.split('/').pop();
    const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
    if (!defaults.has(ext) && !overrides.has('/' + p)) {
      err(`Part /${p} has no content type (no Default for .${ext}, no Override)`, `Add an <Override PartName="/${p}" .../> or a <Default Extension="${ext}" .../> to [Content_Types].xml.`);
    }
  }

  // --- XML well-formedness ---
  for (const p of parts) {
    if (!/\.(xml|rels)$/i.test(p)) continue;
    const xml = await read(p);
    const ok = XMLValidator.validate(xml);
    if (ok !== true) {
      err(`/${p} is not well-formed XML: ${ok.err.msg} (line ${ok.err.line})`, 'Fix the generator or your edit; never pretty-print or reformat OOXML parts.');
    }
  }

  // --- relationship integrity ---
  for (const p of parts.filter((x) => x.endsWith('.rels'))) {
    const xml = await read(p);
    for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
      const tag = m[0];
      if (/TargetMode="External"/.test(tag)) continue;
      const t = tag.match(/Target="([^"]+)"/);
      if (!t) continue;
      const resolved = resolveTarget(p, t[1]);
      if (!parts.includes(resolved)) {
        const id = (tag.match(/Id="([^"]+)"/) || [])[1] || '?';
        err(`/${p} relationship ${id} targets missing part /${resolved}`, 'Remove the relationship or restore the part; if you deleted parts, also delete every relationship that pointed at them.');
      }
    }
  }

  // --- format-specific checks ---
  if (parts.includes('ppt/presentation.xml')) await checkPptx(parts, read);
  else if (parts.includes('word/document.xml')) await checkDocx(parts, read);
  else if (parts.includes('xl/workbook.xml')) await checkXlsx(parts, read);
  else warn('Package is not recognizably pptx, docx, or xlsx — only generic checks ran.');

  if (smoke && errors.length === 0) {
    const { runSoffice } = require('./soffice');
    const os = require('os');
    const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-smoke-'));
    try {
      runSoffice(['--headless', '--convert-to', 'pdf', '--outdir', outdir, path.resolve(file)]);
      const produced = fs.readdirSync(outdir).some((f) => f.endsWith('.pdf'));
      if (!produced) err('LibreOffice could not convert the file to PDF', 'The package passed structural checks but does not open; inspect recently edited parts.');
    } finally {
      fs.rmSync(outdir, { recursive: true, force: true });
    }
  }

  finish();
}

async function checkPptx(parts, read) {
  const pres = await read('ppt/presentation.xml');
  const relsXml = parts.includes('ppt/_rels/presentation.xml.rels') ? await read('ppt/_rels/presentation.xml.rels') : '';
  const relIds = new Set([...relsXml.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of pres.matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)) {
    if (!relIds.has(m[1])) {
      err(`presentation.xml lists slide relationship ${m[1]} that presentation.xml.rels does not define`, 'Every <p:sldId> needs a matching <Relationship> entry; re-add it or remove the sldId.');
    }
  }

  for (const p of parts.filter((x) => /^ppt\/charts\/chart\d*\.xml$/.test(x))) {
    const xml = await read(p);

    // Stacked bar/column + outEnd data labels: PowerPoint reports the file as corrupt.
    for (const chart of xml.matchAll(/<c:barChart>[\s\S]*?<\/c:barChart>/g)) {
      const stacked = /<c:grouping val="(?:stacked|percentStacked)"\/>/.test(chart[0]);
      if (stacked && /<c:dLblPos val="outEnd"\/>/.test(chart[0])) {
        err(`/${p}: stacked bar/column chart uses data-label position "outEnd"`, 'On stacked charts use "ctr", "inEnd", or "inBase"; fix this in the generator options, not the packed XML.');
      }
    }

    // A plot group whose axes were never declared: PowerPoint silently
    // discards the chart and flags the file. This is what pptxgenjs emits
    // for a secondary-axis combo without both valAxes and catAxes.
    // (A group with its 2 axes declared plus one stray extra axId is normal
    // pptxgenjs output that PowerPoint accepts — not flagged.)
    const declared = new Set();
    for (const ax of xml.matchAll(/<c:(?:valAx|catAx|dateAx|serAx)>[\s\S]*?<c:axId val="(\d+)"\/>/g)) declared.add(ax[1]);
    for (const group of xml.matchAll(/<c:(bar|line|area|pie|doughnut|scatter|radar|bubble)Chart>[\s\S]*?<\/c:\1Chart>/g)) {
      const refs = [...group[0].matchAll(/<c:axId val="(\d+)"\/>/g)].map((m) => m[1]);
      if (refs.length === 0) continue; // pie/doughnut groups have no axes
      const declaredRefs = refs.filter((id) => declared.has(id));
      if (declaredRefs.length < 2) {
        err(`/${p}: a ${group[1]} chart group references axes (${refs.join(', ')}) of which only ${declaredRefs.length} are declared`, 'A series on a secondary axis needs the secondary value AND category axes declared (in pptxgenjs: supply both valAxes and catAxes, two entries each).');
      }
    }
  }
}

async function checkDocx(parts, read) {
  const doc = await read('word/document.xml');
  if (!/<w:body[\s>]/.test(doc)) {
    err('word/document.xml has no <w:body>', 'The document part was truncated or overwritten; regenerate it.');
  }
}

async function checkXlsx(parts, read) {
  const wb = await read('xl/workbook.xml');
  const relsXml = parts.includes('xl/_rels/workbook.xml.rels') ? await read('xl/_rels/workbook.xml.rels') : '';
  const relIds = new Set([...relsXml.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of wb.matchAll(/<sheet [^>]*r:id="([^"]+)"/g)) {
    if (!relIds.has(m[1])) {
      err(`xl/workbook.xml lists sheet relationship ${m[1]} that workbook.xml.rels does not define`, 'Every <sheet> needs a matching <Relationship>; re-add it or remove the sheet entry.');
    }
  }
}

function finish() {
  for (const w of warnings) console.log(w);
  for (const e of errors) console.log(e);
  if (errors.length === 0) console.log('OK: package structure, content types, relationships, and XML are valid.');
  process.exit(errors.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(String(e.stack || e));
  process.exit(2);
});
