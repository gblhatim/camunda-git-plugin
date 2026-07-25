/**
 * Camunda Modeler entry point for the Git plugin.
 *
 * Only a `menu` contribution is used - no client-side (bpmn-js) extension
 * is needed, so there is nothing to bundle with webpack. All git/GitHub/
 * GitLab/diagram-diff logic runs in the Electron main process, where full
 * Node access (fs, child_process, `require('electron')`) is available.
 *
 * See: https://docs.camunda.io/docs/components/modeler/desktop-modeler/plugins/
 */

'use strict';

module.exports = {

  // NOTE: this name is also the host segment of the `app-plugins://` URL
  // Modeler uses to serve this folder's files to the renderer, so it must
  // stay URL-safe (no spaces). The client bundle fetches
  // `app-plugins://camunda-git-plugin/bridge.json` to find the bridge.
  name: 'camunda-git-plugin',

  menu: './menu/menu.js',

  // Loaded as a <link> into the renderer. Keeps styling out of the
  // components; see client/styles.css.
  style: './client/styles.css',

  // Client-side (renderer) React extension - see client/ and webpack.config.js.
  // Must be a pre-built bundle; run `npm run build` after changing client/.
  script: './client/dist/client.js'
};
