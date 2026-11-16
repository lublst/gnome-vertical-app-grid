import GLib from 'gi://GLib';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

// Launchers and window classes used by many unrelated apps, so they can't
// tell two apps apart
const SHARED_PROGRAMS = new Set(['env', 'sh', 'bash', 'python', 'python3', 'node', 'java', 'wine', 'electron', 'xdg-open', 'gtk-launch']);

const BROWSERS = /\b(chrome|chromium|brave|vivaldi|opera|edge|firefoxpwa)\b/;

function normalize(text) {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function getAppSource(appInfo) {
  const commandLine = appInfo.get_commandline()?.toLowerCase() ?? '';
  const wmClass = appInfo.get_startup_wm_class() ?? '';

  const isBrowserApp = BROWSERS.test(commandLine) &&
    (commandLine.includes('--app-id=') || commandLine.includes('--app=') || commandLine.includes('site launch'));

  // Web apps of a Flatpak browser are started with "flatpak run" too
  if (wmClass.startsWith('crx_') || isBrowserApp) {
    return 'web';
  }

  // Some apps replace the launcher of a Flatpak with their own, without the X-Flatpak key
  if (appInfo.has_key('X-Flatpak') || commandLine.includes('flatpak run')) {
    return 'flatpak';
  }

  if (appInfo.has_key('X-SnapInstanceName')) {
    return 'snap';
  }

  if (commandLine.includes('.appimage')) {
    return 'appimage';
  }

  return 'system';
}

// Returns a short label describing how an app was installed
export function getAppSourceName(appInfo) {
  switch (getAppSource(appInfo)) {
    case 'web':
      return _('Web');

    case 'flatpak':
      return 'Flatpak';

    case 'snap':
      return 'Snap';

    case 'appimage':
      return 'AppImage';

    default:
      return _('System');
  }
}

// Returns the program started by an app (for example "gimp" for both
// "gimp-3.2 %U" and the org.gimp.GIMP Flatpak), or null when the launcher
// may be shared by several apps
function getAppProgram(app, source) {
  const appInfo = app.get_app_info();
  const args = (appInfo.get_commandline() ?? '').split(/\s+/).filter(arg => arg && !arg.startsWith('%'));

  if (source === 'flatpak') {
    const runArgs = args.slice(args.indexOf('run') + 1).filter(arg => !arg.startsWith('-') && !arg.startsWith('@@'));
    const flatpakId = appInfo.get_string('X-Flatpak') ?? runArgs[0];

    // Only the main launcher of a Flatpak stands for the whole app
    return app.get_id() === `${flatpakId}.desktop` ? flatpakId.split('.').pop() : null;
  }

  // Skip environment variables such as "env FOO=1 program"
  const programArgs = args.filter(arg => arg !== 'env' && !/^[A-Za-z_]+=/.test(arg));
  const program = GLib.path_get_basename(programArgs[0] ?? '')
    .replace(/\.appimage$/i, '')
    .replace(/-[\d.]+$/, '');

  // Commands with arguments often start one app of a suite or of a launcher
  if (programArgs.length !== 1 || SHARED_PROGRAMS.has(program)) {
    return null;
  }

  return program;
}

function getAppKeys(app) {
  const appInfo = app.get_app_info();
  const source = getAppSource(appInfo);
  const keys = [`name:${normalize(app.get_name())}`];

  // Web apps all start the same browser
  if (source !== 'web') {
    const wmClass = appInfo.get_startup_wm_class()?.toLowerCase();
    const program = getAppProgram(app, source);

    if (wmClass && !SHARED_PROGRAMS.has(wmClass)) {
      keys.push(`program:${normalize(wmClass)}`);
    }

    if (program) {
      keys.push(`program:${normalize(program)}`);
    }
  }

  return keys.filter(key => !key.endsWith(':'));
}

// Returns the ids of apps that look like the same program as another app:
// same name, same program started or same window class
export function findDuplicateApps(apps) {
  // Apps sharing a key are joined in the same group (union-find)
  const parents = new Map();
  const keyOwners = new Map();
  const findRoot = id => parents.get(id) === id ? id : findRoot(parents.get(id));

  apps.forEach(app => {
    const id = app.get_id();

    parents.set(id, id);

    getAppKeys(app).forEach(key => {
      if (keyOwners.has(key)) {
        parents.set(findRoot(id), findRoot(keyOwners.get(key)));
      } else {
        keyOwners.set(key, id);
      }
    });
  });

  const groupSizes = new Map();

  parents.forEach((_parent, id) => {
    const root = findRoot(id);
    groupSizes.set(root, (groupSizes.get(root) ?? 0) + 1);
  });

  return new Set([...parents.keys()].filter(id => groupSizes.get(findRoot(id)) > 1));
}
