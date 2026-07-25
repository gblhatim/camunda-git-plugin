/**
 * Bundles the client-side (renderer) extension.
 *
 * Camunda Modeler loads `script` plugins as a plain <script> tag, so the
 * output has to be a single self-contained file with no module system.
 *
 * React is NOT bundled: camunda-modeler-plugin-helpers reads it off
 * `window.react`, which Modeler binds before script plugins load. That
 * keeps a single React instance in the renderer.
 */

'use strict';

const path = require('path');

module.exports = {
  mode: 'production',
  target: 'web',
  entry: './client/index.js',
  output: {
    path: path.resolve(__dirname, 'client', 'dist'),
    filename: 'client.js'
  },
  performance: {
    // The bundle is tiny; no need for size hints on a plugin.
    hints: false
  },
  devtool: false
};
