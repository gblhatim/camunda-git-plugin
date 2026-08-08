#!/usr/bin/env node
/**
 * Builds bdm-2.0-presentation.html: one self-contained file.
 *
 * Everything is inlined — the bpmn.io viewer bundle, its stylesheets, the BPMN
 * icon font (as a data URI), the deck CSS/JS and every .bpmn source. The result
 * opens from a USB stick with no network and no build step.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'presentation');
const VENDOR = path.join(ROOT, 'node_modules', 'bpmn-js', 'dist');
const OUT = path.join(ROOT, 'bdm-2.0-presentation.html');

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

/* ---- 1. BPMN icon font, inlined as a data URI ---------------------------- */
function bpmnFontCss() {
  const woff2 = fs.readFileSync(path.join(VENDOR, 'assets', 'bpmn-font', 'font', 'bpmn.woff2')).toString('base64');
  const css = read(VENDOR, 'assets', 'bpmn-font', 'css', 'bpmn.css');
  // drop the original @font-face (it points at files on disk) and keep the icon classes
  const icons = css.replace(/@font-face\s*\{[\s\S]*?\}/, '').replace(/^@charset[^;]+;/, '');
  return (
    "@font-face{font-family:'bpmn';font-style:normal;font-weight:normal;" +
    "src:url(data:font/woff2;charset=utf-8;base64," + woff2 + ") format('woff2');}\n" +
    icons
  );
}

/* ---- 2. slides ----------------------------------------------------------- */
function slides() {
  const dir = path.join(SRC, 'slides');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.html')).sort();
  if (!files.length) throw new Error('no slides found in ' + dir);
  console.log('  slides   : ' + files.length + ' (' + files[0] + ' … ' + files[files.length - 1] + ')');
  return files.map((f) => read(dir, f).trim()).join('\n\n');
}

/* ---- 3. diagrams --------------------------------------------------------- */
function diagrams() {
  const dir = path.join(SRC, 'diagrams');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.bpmn')).sort();
  const map = {};
  files.forEach((f) => { map[path.basename(f, '.bpmn')] = read(dir, f); });
  console.log('  diagrams : ' + files.map((f) => path.basename(f, '.bpmn')).join(', '));
  // escaping "</" keeps a stray </script> inside a diagram from closing the tag
  const json = JSON.stringify(map).replace(/<\//g, '<\\/');
  return 'window.__DIAGRAMS__ = ' + json + ';';
}

/* ---- 4. assemble --------------------------------------------------------- */
function build() {
  console.log('Building BDM 2.0 presentation…');

  const parts = {
    '/*@FONT_BPMN*/': bpmnFontCss(),
    '/*@CSS_VENDOR*/': read(VENDOR, 'assets', 'diagram-js.css') + '\n' + read(VENDOR, 'assets', 'bpmn-js.css'),
    '/*@CSS_DECK*/': read(SRC, 'styles', 'deck.css'),
    '<!--@SLIDES-->': slides(),
    '/*@DIAGRAMS*/': diagrams(),
    '/*@JS_VENDOR*/': read(VENDOR, 'bpmn-navigated-viewer.production.min.js'),
    '/*@JS_DECK*/': [
      read(SRC, 'scripts', 'core.js'),
      read(SRC, 'scripts', 'bpmn.js'),
      read(SRC, 'scripts', 'widgets.js')
    ].join('\n')
  };

  let html = read(SRC, 'shell.html');
  Object.keys(parts).forEach((token) => {
    if (!html.includes(token)) throw new Error('token missing from shell.html: ' + token);
    // function form: keeps $& and friends in the payload from being expanded
    html = html.replace(token, () => parts[token]);
  });

  fs.writeFileSync(OUT, html, 'utf8');
  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(0);
  console.log('  → ' + path.relative(ROOT, OUT) + '  (' + kb + ' KB, self-contained)');
}

build();
