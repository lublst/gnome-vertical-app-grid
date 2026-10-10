import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import { SwipeTracker } from 'resource:///org/gnome/shell/ui/swipeTracker.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SIDE_CONTROLS_ANIMATION_TIME } from 'resource:///org/gnome/shell/ui/overviewControls.js';

function easeOutCubic(t) {
  return (--t) * t * t + 1;
}

const DRAG_FLIP_DURATION = 250;
const AUTO_SCROLL_EDGE = 48;
const AUTO_SCROLL_SPEED = 10;

const DISTRO_RESTRICTED_FOLDERS = {
  YaST: ['suse', 'opensuse'],
  Pardus: ['pardus']
};

let _distroIds = null;

function getDistroIds() {
  if (_distroIds) {
    return _distroIds;
  }

  _distroIds = new Set();

  try {
    const [ok, contents] = GLib.file_get_contents('/etc/os-release');

    if (ok) {
      const text = new TextDecoder().decode(contents);

      ['ID', 'ID_LIKE'].forEach(key => {
        const match = text.match(new RegExp(`^${key}=(.*)$`, 'm'));
        if (match) {
          match[1].replace(/^"|"$/g, '').toLowerCase().split(/\s+/).forEach(id => {
            if (id) {
              _distroIds.add(id);
            }
          });
        }
      });
    }
  } catch (error) {
    logError(error, '[vertical-app-grid-max] failed to read /etc/os-release');
  }

  return _distroIds;
}

function isFolderAllowedOnThisDistro(id) {
  const requiredIds = DISTRO_RESTRICTED_FOLDERS[id];

  if (!requiredIds) {
    return true;
  }

  const distroIds = getDistroIds();
  return requiredIds.some(required => distroIds.has(required));
}

function promptText(title, initialText, onConfirm) {
  const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true });

  const content = new St.BoxLayout({
    vertical: true,
    style: 'spacing: 12px; padding: 6px 6px 12px 6px; min-width: 320px;'
  });

  content.add_child(new St.Label({
    text: title,
    style: 'font-weight: bold; font-size: 15px;'
  }));

  const entry = new St.Entry({
    text: initialText ?? '',
    can_focus: true,
    x_expand: true
  });

  entry.clutter_text.connect('activate', () => confirm());

  content.add_child(entry);
  dialog.contentLayout.add_child(content);

  const confirm = () => {
    const text = entry.get_text().trim();
    dialog.close();
    if (text) {
      onConfirm(text);
    }
  };

  dialog.setButtons([
    {
      label: _('Cancel'),
      action: () => dialog.close(),
      key: Clutter.KEY_Escape
    },
    {
      label: _('OK'),
      action: confirm,
      default: true
    }
  ]);

  dialog.open();

  const laterId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
    global.stage.set_key_focus(entry);
    global.compositor.get_laters().remove(laterId);
    return GLib.SOURCE_REMOVE;
  });
}

export const VerticalAppDisplay = GObject.registerClass(
class VerticalAppDisplay extends St.Widget {
  _init(settings) {
    this._settings = settings;
    this._laters = global.compositor.get_laters();

    super._init({
      layout_manager: new Clutter.BinLayout(),
      can_focus: true,
      reactive: true
    });

    this._pinnedView = new St.Viewport({
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      layout_manager: new VerticalLayout(settings)
    });

    this._foldersView = new St.Viewport({
      x_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      layout_manager: new VerticalLayout(settings)
    });

    this._mainView = new St.Viewport({
      layout_manager: new VerticalLayout(settings)
    });

    this._scrollView = new VerticalScrollView(settings);

    this._scrollView.add_child(this._pinnedView);
    this._scrollView.add_child(this._foldersView);
    this._scrollView.add_child(this._mainView);

    this.add_child(this._scrollView);

    this._appSystem = Shell.AppSystem.get_default();
    this._appUsage = Shell.AppUsage.get_default();
    this._parentalControls = ParentalControlsManager.getDefault();
    this._overview = Main.overview;

    this._folderSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
    this._folderIconCache = new Map();
    this._dragPreview = null;
    this._autoScrollDirection = 0;
    this._autoScrollTimer = null;

    this._pinnedView._delegate = this._createDropTarget('pinned');
    this._foldersView._delegate = this._createDropTarget('folders');
    this._mainView._delegate = this._createDropTarget('main');

    this._connectSignals();
    this._addAppIcons();
    this._updateSectionSpacing();
  }

  _connectSignals() {
    this._appSystem.connectObject('installed-changed', () => {
      this._redisplay();
    }, this);

    this._parentalControls.connectObject('app-filter-changed', () => {
      this._redisplay();
    }, this);

    this._folderSettings.connectObject('changed::folder-children', () => {
      this._redisplay();
    }, this);

    this._overview.connectObject('hidden', () => {
      this._scrollView.scrollTo(0, false);
    }, this);

    this._settings.connectObject('changed', (_settings, key) => {
      switch (key) {
        case 'app-sorting':
        case 'pinned-sorting':
        case 'pinned-apps':
        case 'pinned-order':
        case 'hidden-apps':
        case 'custom-order':
        case 'folders-section':
        case 'folders-order':
          return this._redisplay();

        case 'icon-spacing':
          return this._updateSectionSpacing();

        case 'icon-size':
          return this._updateIconSize();
      }
    }, this);
  }

  isHidden(appId) {
    return this._settings.get_strv('hidden-apps').includes(appId);
  }

  toggleHidden(appId) {
    const hidden = new Set(this._settings.get_strv('hidden-apps'));

    if (hidden.has(appId)) {
      hidden.delete(appId);
    } else {
      hidden.add(appId);
      this._removeAppFromFolder(appId, { silent: true });
    }

    this._settings.set_strv('hidden-apps', [...hidden]);
  }

  isPinned(appId) {
    return this._settings.get_strv('pinned-apps').includes(appId);
  }

  togglePinned(appId) {
    const pinned = new Set(this._settings.get_strv('pinned-apps'));

    if (pinned.has(appId)) {
      pinned.delete(appId);
    } else {
      pinned.add(appId);
    }

    this._settings.set_strv('pinned-apps', [...pinned]);
  }

  _folderPath(id) {
    return `${this._folderSettings.path}folders/${id}/`;
  }

  _folderIds() {
    return this._folderSettings.get_strv('folder-children');
  }

  _getFolderSettings(id) {
    return new Gio.Settings({
      schema_id: 'org.gnome.desktop.app-folders.folder',
      path: this._folderPath(id)
    });
  }

  _getFolderName(folder) {
    const name = folder.get_string('name');

    if (folder.get_boolean('translate')) {
      const translated = Shell.util_get_translated_folder_name(name);
      if (translated) {
        return translated;
      }

      if (name.endsWith('.directory')) {
        return name
          .replace(/\.directory$/, '')
          .replace(/^X-/, '')
          .split(/[-_]+/)
          .filter(Boolean)
          .map(word => word[0].toUpperCase() + word.slice(1))
          .join(' ');
      }
    }

    return name;
  }

  _getOrCreateFolderIcon(id) {
    let icon = this._folderIconCache.get(id);

    if (!icon) {
      icon = new AppDisplay.FolderIcon(id, this._folderPath(id), this);

      icon._folder.disconnectObject(icon);
      AppFavorites.getAppFavorites().disconnectObject(icon);
      icon.view._appFavorites = { isFavorite: appId => this.isPinned(appId) };

      // Replaces the GNOME-internal listener just disconnected above, so a
      // rename (or any other settings change) made through paths other than
      // our own — e.g. the pencil-icon rename inside the folder's own open
      // popup — still refreshes the closed icon on the main screen, the same
      // way our own promptRenameFolder() already does explicitly.
      icon._folder.connectObject('changed', () => {
        this._syncFolderIcon(id);
        this._redisplay();
      }, this);

      icon.connect('apps-changed', () => this._redisplay());
      icon.connect('destroy', () => this._folderIconCache.delete(id));

      this._addFolderContextMenu(icon, id);

      this._folderIconCache.set(id, icon);
      icon._sync();
    }

    return icon;
  }

  _addFolderContextMenu(icon, id) {
    const menuManager = new PopupMenu.PopupMenuManager(icon);
    const menu = new PopupMenu.PopupMenu(icon, 0.5, St.Side.BOTTOM);

    menu.addAction(_('Rename Folder…'), () => this.promptRenameFolder(id));
    menu.addAction(_('Delete Folder'), () => this.deleteFolder(id));

    Main.uiGroup.add_child(menu.actor);
    menu.actor.hide();
    menuManager.addMenu(menu);

    const openMenu = () => menu.open();

    const longPressGesture = new Clutter.LongPressGesture();
    longPressGesture.connect('recognize', openMenu);
    icon.add_action(longPressGesture);

    const rightClickGesture = new Clutter.ClickGesture({
      required_button: Clutter.BUTTON_SECONDARY,
      recognize_on_press: true
    });
    rightClickGesture.connect('recognize', openMenu);
    icon.add_action(rightClickGesture);

    icon.connect('destroy', () => menu.destroy());
  }

  addFolderDialog(dialog) {
    Main.layoutManager.overviewGroup.add_child(dialog);
  }

  getAppInfos() {
    return this._appSystem.get_installed();
  }

  selectApp(_id) {
  }

  getFolders() {
    const result = {};

    this._folderIds().forEach(id => {
      const folder = this._getFolderSettings(id);
      const apps = folder.get_strv('apps');

      if (apps.length === 0 && !isFolderAllowedOnThisDistro(id)) {
        return;
      }

      result[id] = {
        name: this._getFolderName(folder),
        apps
      };
    });

    return result;
  }

  getAppFolder(appId) {
    return this._folderIds().find(id => {
      return this._getFolderSettings(id).get_strv('apps').includes(appId);
    }) ?? null;
  }

  promptNewFolder(appId) {
    promptText(_('New Folder'), '', name => {
      const id = this._createFolder(name, [appId]);
      this._redisplay();
      return id;
    });
  }

  promptRenameFolder(folderId) {
    const folder = this._getFolderSettings(folderId);

    promptText(_('Rename Folder'), this._getFolderName(folder), name => {
      folder.set_string('name', name);
      folder.set_boolean('translate', false);
      this._syncFolderIcon(folderId);
      this._redisplay();
    });
  }

  deleteFolder(folderId) {
    this._deleteFolderById(folderId);
    this._redisplay();
  }

  addAppToFolder(folderId, appId) {
    this._folderIds().forEach(id => {
      if (id !== folderId) {
        this._removeAppFromFolderSettings(this._getFolderSettings(id), appId);
      }
    });

    const folder = this._getFolderSettings(folderId);
    const apps = folder.get_strv('apps');

    if (!apps.includes(appId)) {
      apps.push(appId);
      folder.set_strv('apps', apps);
      this._syncFolderIcon(folderId);
    }

    this._redisplay();
  }

  removeAppFromFolder(appId) {
    this._removeAppFromFolder(appId);
  }

  _removeAppFromFolder(appId, { silent = false } = {}) {
    this._folderIds().forEach(id => {
      this._removeAppFromFolderSettings(this._getFolderSettings(id), appId);
    });

    if (!silent) {
      this._redisplay();
    }
  }

  _removeAppFromFolderSettings(folder, appId) {
    const apps = folder.get_strv('apps');
    const index = apps.indexOf(appId);

    if (index === -1) {
      return;
    }

    apps.splice(index, 1);

    const isEmptyPlaceholder = apps.length === 0 && folder.get_strv('categories').length > 0;

    if (apps.length <= 1 && !isEmptyPlaceholder) {
      this._deleteFolderById(null, folder);
    } else {
      folder.set_strv('apps', apps);
      this._syncFolderIcon(this._idFromFolderPath(folder.path));
    }
  }

  _syncFolderIcon(id) {
    this._folderIconCache.get(id)?.destroy();
  }

  _createFolder(name, apps) {
    const id = GLib.uuid_string_random();

    const folderIds = this._folderIds();
    folderIds.push(id);
    this._folderSettings.set_strv('folder-children', folderIds);

    const folder = this._getFolderSettings(id);
    folder.delay();
    folder.set_string('name', name);
    folder.set_strv('apps', apps);
    folder.apply();

    return id;
  }

  _createFolderFromDrop(targetAppId, sourceAppId) {
    this._createFolder(_('New Folder'), [targetAppId, sourceAppId]);
    this._redisplay();
  }

  _deleteFolderById(id, folder) {
    folder ??= this._getFolderSettings(id);
    id ??= this._idFromFolderPath(folder.path);

    folder.settings_schema.list_keys().forEach(key => folder.reset(key));

    const folderIds = this._folderIds().filter(existingId => existingId !== id);
    this._folderSettings.set_strv('folder-children', folderIds);

    this._folderIconCache.get(id)?.destroy();
  }

  _idFromFolderPath(path) {
    const match = /\/folders\/([^/]+)\/$/.exec(path);
    return match ? match[1] : null;
  }

  openFolder(folderId) {
    this._getOrCreateFolderIcon(folderId).open();
  }

  _matchDragActorToIcon(icon) {
    icon.getDragActor = () => {
      icon._suppressLabelHover?.();

      return new Clutter.Clone({
        source: icon.icon,
        width: icon.icon.width,
        height: icon.icon.height
      });
    };
  }

  // Fully own the icon label's truncated-vs-full-name state instead of relying
  // on GNOME's own internal hover handling for it: collapsed (ellipsized, one
  // line) at rest and while pressed/dragged, expanded to the full name only
  // while genuinely hovering. Wraps on word boundaries only — never mid-word
  // with an inserted hyphen — so a name only ever breaks where it already has
  // a natural break (a space, or a hyphen it already contains).
  _setupLabelHover(icon) {
    if (icon._labelHoverReady) {
      return;
    }

    const clutterText = icon.icon?.label?.clutter_text;

    if (!clutterText) {
      return;
    }

    icon._labelHoverReady = true;

    // Only this one icon's own allocated box grows to fit the full name (see
    // VerticalLayout.vfunc_allocate) — every other icon keeps the compact,
    // collapsed-sized box, so hovering one icon never resizes the grid around
    // it. Deliberately not raised above its siblings to avoid covering the
    // row below it — reordering an actor's sibling position also reorders it
    // in get_children(), which this grid's layout uses to compute every
    // icon's row/column, so doing that reshuffled the entire grid.
    const collapse = () => {
      clutterText.set({
        line_wrap: false,
        ellipsize: Pango.EllipsizeMode.END
      });

      if (icon._hoverExpanded) {
        icon._hoverExpanded = false;
        icon.get_parent()?.layout_manager?.layout_changed();
      }
    };

    const expand = () => {
      clutterText.set({
        line_wrap: true,
        line_wrap_mode: Pango.WrapMode.WORD,
        ellipsize: Pango.EllipsizeMode.NONE
      });

      icon._hoverExpanded = true;
      icon.get_parent()?.layout_manager?.layout_changed();
    };

    collapse();

    icon._labelSuppressed = false;

    icon._suppressLabelHover = () => {
      icon._labelSuppressed = true;
      collapse();
    };

    icon.connect('notify::hover', () => {
      if (!icon._labelSuppressed) {
        icon.hover ? expand() : collapse();
      }
    });

    icon.connect('button-press-event', () => {
      icon._suppressLabelHover();
      return Clutter.EVENT_PROPAGATE;
    });

    const release = () => {
      icon._labelSuppressed = false;
      icon.hover ? expand() : collapse();
    };

    icon.connect('button-release-event', release);

    // A cancelled drag never fires its own button-release-event on this actor
    // (the DND grab intercepts it) — GNOME's own drag-cancel restores
    // `reactive` to true once it's done, so use that as the "drag is over"
    // signal instead.
    icon.connect('notify::reactive', () => {
      if (icon.reactive) {
        release();
      }
    });
  }

  _addAppIcons() {
    const iconSize = this._settings.get_int('icon-size');

    const { pinned, folders, main } = this._loadEntries();

    const makeIcon = entry => {
      if (entry.type === 'folder') {
        const folderIcon = this._getOrCreateFolderIcon(entry.id);
        folderIcon.icon.setIconSize(iconSize);
        folderIcon.visible = true;
        folderIcon.translation_x = 0;
        folderIcon.translation_y = 0;
        this._matchDragActorToIcon(folderIcon);
        this._setupLabelHover(folderIcon);
        return folderIcon;
      }

      const app = this._appSystem.lookup_app(entry.id);
      if (!app) {
        return null;
      }

      const appIcon = new AppDisplay.AppIcon(app, { isDraggable: true });
      appIcon.icon.setIconSize(iconSize);
      this._matchDragActorToIcon(appIcon);
      this._setupLabelHover(appIcon);
      return appIcon;
    };

    this._appIcons = [];

    pinned.forEach(entry => {
      const icon = makeIcon(entry);
      if (icon) {
        this._pinnedView.add_child(icon);
        this._appIcons.push(icon);
      }
    });

    folders.forEach(entry => {
      const icon = makeIcon(entry);
      if (icon) {
        this._foldersView.add_child(icon);
        this._appIcons.push(icon);
      }
    });

    main.forEach(entry => {
      const icon = makeIcon(entry);
      if (icon) {
        this._mainView.add_child(icon);
        this._appIcons.push(icon);
      }
    });

    this._pinnedView.visible = this._pinnedView.get_children().length > 0;
    this._foldersView.visible = this._foldersView.get_children().length > 0;
    this._mainView.visible = this._mainView.get_children().length > 0;
  }

  _loadEntries() {
    const installedApps = this._appSystem.get_installed();

    const hiddenApps = new Set(this._settings.get_strv('hidden-apps'));

    const folderedAppIds = new Set();
    const folderEntries = [];

    this._folderIds().forEach(id => {
      const folder = this._getFolderSettings(id);
      const apps = folder.get_strv('apps').filter(appId => !this.isPinned(appId));

      if (apps.length === 0) {
        return;
      }

      apps.forEach(appId => folderedAppIds.add(appId));
      folderEntries.push({ type: 'folder', id, name: this._getFolderName(folder) });
    });

    folderEntries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    const pinned = [];
    const apps = [];

    installedApps.forEach(appInfo => { try {
      const appId = appInfo.get_id();

      if (hiddenApps.has(appId) || !this._parentalControls.shouldShowApp(appInfo)) {
        return;
      }

      if (this.isPinned(appId)) {
        pinned.push(appInfo);
        return;
      }

      if (folderedAppIds.has(appId)) {
        return;
      }

      apps.push(appInfo);
    } catch { } });

    const pinnedSorting = this._settings.get_string('pinned-sorting');

    pinned.sort((a, b) => {
      switch (pinnedSorting) {
        case 'usage':
          return this._appUsage.compare(a.get_id(), b.get_id()) ?? 0;

        case 'alphabetical': case 'custom': default:
          return a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase());
      }
    });

    const appSorting = this._settings.get_string('app-sorting');

    apps.sort((a, b) => {
      switch (appSorting) {
        case 'usage':
          return this._appUsage.compare(a.get_id(), b.get_id()) ?? 0;

        case 'alphabetical': case 'custom': default:
          return a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase());
      }
    });

    const appEntries = apps.map(appInfo => ({ type: 'app', id: appInfo.get_id() }));

    const foldersSection = this._settings.get_boolean('folders-section');

    let folders = [];
    let mainEntries;

    if (foldersSection) {
      folders = this._applyFoldersOrder(folderEntries);
      mainEntries = appEntries;
    } else {
      mainEntries = [...folderEntries, ...appEntries];
    }

    if (appSorting === 'custom') {
      mainEntries = this._applyCustomOrder(mainEntries);
    }

    let pinnedEntries = pinned.map(appInfo => ({ type: 'app', id: appInfo.get_id() }));

    if (pinnedSorting === 'custom') {
      pinnedEntries = this._applyPinnedOrder(pinnedEntries);
    }

    return {
      pinned: pinnedEntries,
      folders,
      main: mainEntries
    };
  }

  _applyFoldersOrder(entries) {
    let order;

    try {
      order = JSON.parse(this._settings.get_string('folders-order'));
      if (!Array.isArray(order)) {
        order = [];
      }
    } catch {
      order = [];
    }

    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const ordered = [];

    order.forEach(id => {
      const entry = byId.get(id);
      if (entry) {
        ordered.push(entry);
        byId.delete(id);
      }
    });

    return [...ordered, ...byId.values()];
  }

  _applyCustomOrder(entries) {
    const order = this._getCustomOrder();
    const entryKey = entry => entry.type === 'folder' ? `folder:${entry.id}` : entry.id;

    const byKey = new Map(entries.map(entry => [entryKey(entry), entry]));
    const ordered = [];

    order.forEach(key => {
      const entry = byKey.get(key);
      if (entry) {
        ordered.push(entry);
        byKey.delete(key);
      }
    });

    return [...ordered, ...byKey.values()];
  }

  _getCustomOrder() {
    try {
      const order = JSON.parse(this._settings.get_string('custom-order'));
      return Array.isArray(order) ? order : [];
    } catch {
      return [];
    }
  }

  _setCustomOrder(order) {
    this._settings.set_string('custom-order', JSON.stringify(order));
  }

  _applyPinnedOrder(entries) {
    const order = this._getPinnedOrder();
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const ordered = [];

    order.forEach(id => {
      const entry = byId.get(id);
      if (entry) {
        ordered.push(entry);
        byId.delete(id);
      }
    });

    return [...ordered, ...byId.values()];
  }

  _getPinnedOrder() {
    try {
      const order = JSON.parse(this._settings.get_string('pinned-order'));
      return Array.isArray(order) ? order : [];
    } catch {
      return [];
    }
  }

  _setPinnedOrder(order) {
    this._settings.set_string('pinned-order', JSON.stringify(order));
  }

  reorderMainEntry(key, targetIndex) {
    const currentKeys = this._mainView.get_children()
      .map(icon => this._keyForIcon(icon))
      .filter(Boolean);

    const oldIndex = currentKeys.indexOf(key);
    const adjustedIndex = (oldIndex !== -1 && oldIndex < targetIndex) ? targetIndex - 1 : targetIndex;

    const withoutKey = currentKeys.filter(k => k !== key);
    const clampedIndex = Math.min(Math.max(adjustedIndex, 0), withoutKey.length);

    withoutKey.splice(clampedIndex, 0, key);
    this._setCustomOrder(withoutKey);

    if (this._settings.get_string('app-sorting') !== 'custom') {
      this._settings.set_string('app-sorting', 'custom');
    }
  }

  reorderPinned(appId, targetIndex) {
    const currentIds = this._pinnedView.get_children().map(icon => icon.id).filter(Boolean);

    const oldIndex = currentIds.indexOf(appId);
    const adjustedIndex = (oldIndex !== -1 && oldIndex < targetIndex) ? targetIndex - 1 : targetIndex;

    const withoutId = currentIds.filter(id => id !== appId);
    const pos = Math.min(Math.max(adjustedIndex, 0), withoutId.length);

    withoutId.splice(pos, 0, appId);
    this._setPinnedOrder(withoutId);

    if (this._settings.get_string('pinned-sorting') !== 'custom') {
      this._settings.set_string('pinned-sorting', 'custom');
    }
  }

  reorderFolderEntry(folderId, targetIndex) {
    const currentIds = this._foldersView.get_children()
      .filter(icon => icon instanceof AppDisplay.FolderIcon)
      .map(icon => icon.id);

    const oldIndex = currentIds.indexOf(folderId);
    const adjustedIndex = (oldIndex !== -1 && oldIndex < targetIndex) ? targetIndex - 1 : targetIndex;

    const withoutId = currentIds.filter(id => id !== folderId);
    const clampedIndex = Math.min(Math.max(adjustedIndex, 0), withoutId.length);

    withoutId.splice(clampedIndex, 0, folderId);
    this._settings.set_string('folders-order', JSON.stringify(withoutId));
  }

  _keyForIcon(icon) {
    if (icon instanceof AppDisplay.FolderIcon) {
      return `folder:${icon.id}`;
    }

    if (icon instanceof AppDisplay.AppIcon) {
      return icon.id;
    }

    return null;
  }

  _createDropTarget(section) {
    return {
      handleDragOver: (source, _actor, x, y, _time) => this._onDragMotion(section, source, x, y),
      acceptDrop: (source, _actor, x, y, _time) => this._onDrop(section, source, x, y)
    };
  }

  _isValidDragSource(source) {
    return source instanceof AppDisplay.AppIcon || source instanceof AppDisplay.FolderIcon;
  }

  _viewForSection(section) {
    switch (section) {
      case 'pinned': return this._pinnedView;
      case 'folders': return this._foldersView;
      default: return this._mainView;
    }
  }

  _onDragMotion(section, source, x, y) {
    if (!this._isValidDragSource(source)) {
      this._clearDragPreview();
      this._stopAutoScroll();
      return DND.DragMotionResult.NO_DROP;
    }

    this._updateAutoScroll(this._viewForSection(section), x, y);
    this._updateDragPreview(section, source, x, y);

    return DND.DragMotionResult.MOVE_DROP;
  }

  // Lets a drag reach parts of the grid currently scrolled out of view: while
  // the cursor sits near the top or bottom edge of the scrollable area, keep
  // scrolling that direction for as long as it stays there.
  _updateAutoScroll(view, x, y) {
    const [, viewY] = view.get_transformed_position();
    const [, scrollViewY] = this._scrollView.get_transformed_position();
    const scrollViewHeight = this._scrollView.height;

    const localY = (viewY - scrollViewY) + y;

    let direction = 0;
    if (localY < AUTO_SCROLL_EDGE) {
      direction = -1;
    } else if (localY > scrollViewHeight - AUTO_SCROLL_EDGE) {
      direction = 1;
    }

    if (direction === this._autoScrollDirection) {
      return;
    }

    this._autoScrollDirection = direction;

    if (direction === 0) {
      this._stopAutoScrollTimer();
      return;
    }

    if (this._autoScrollTimer) {
      return;
    }

    this._autoScrollTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      if (this._autoScrollDirection === 0) {
        this._autoScrollTimer = null;
        return GLib.SOURCE_REMOVE;
      }

      this._scrollView.scrollTo(this._scrollView.scroll + this._autoScrollDirection * AUTO_SCROLL_SPEED, false);
      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopAutoScroll() {
    this._autoScrollDirection = 0;
    this._stopAutoScrollTimer();
  }

  _stopAutoScrollTimer() {
    if (this._autoScrollTimer) {
      GLib.source_remove(this._autoScrollTimer);
      this._autoScrollTimer = null;
    }
  }

  _canReorderInSection(section, isFolder) {
    if (section === 'pinned' && isFolder) {
      return false;
    }

    if (section === 'folders' && !isFolder) {
      return false;
    }

    return true;
  }

  _gridPosition(view, index) {
    const children = view.get_children();
    const layout = view.layout_manager;
    const childSize = layout._getMinChildSize(children);
    const columns = layout._columns;
    const spacing = layout._spacing;

    return {
      x: (index % columns) * (childSize + spacing),
      y: Math.floor(index / columns) * (childSize + spacing)
    };
  }

  _previewSlot(k, index) {
    return k < index ? k : k + 1;
  }

  _updateDragPreview(section, source, x, y) {
    const isFolder = source instanceof AppDisplay.FolderIcon;

    if (!this._canReorderInSection(section, isFolder)) {
      this._clearDragPreview();
      return;
    }

    const view = this._viewForSection(section);

    if (!this._dragPreview || this._dragPreview.view !== view) {
      this._clearDragPreview();

      const liveChildren = view.get_children();
      const sourceHomeIndex = liveChildren.indexOf(source);

      this._dragPreview = {
        view,
        order: liveChildren.filter(icon => icon !== source),
        sourceHomeIndex,
        // Always start from where the dragged icon actually is, not from
        // wherever the cursor first happens to be once the drag threshold is
        // crossed (which can already be a slot or two off) — otherwise the
        // very first step can mis-identify which icon should flip.
        index: sourceHomeIndex,
        busy: false,
        lastX: x,
        lastY: y
      };
    }

    this._dragPreview.lastX = x;
    this._dragPreview.lastY = y;

    if (!this._dragPreview.busy) {
      this._advanceDragPreview();
    }
  }

  // Advances the preview toward the latest known cursor position, then waits
  // for that step's animation(s) to actually finish (via onComplete, not a
  // timer) before advancing again — so it's structurally impossible for a new
  // step to begin while a previous one is still mid-flip. Within a row, a step
  // moves exactly one icon at a time for a clear, deliberate feel; crossing
  // into a different row jumps straight to the target, animating that whole
  // row's worth of icons together, since making each one wait its turn would
  // make crossing a row take far too long.
  _advanceDragPreview() {
    const preview = this._dragPreview;

    if (!preview || preview.busy) {
      return;
    }

    const target = this._getDropTarget(preview.view, preview.lastX, preview.lastY);

    if (target.type === 'merge') {
      return;
    }

    const rawIndex = Math.min(Math.max(target.index, 0), preview.order.length);

    if (rawIndex === preview.index) {
      return;
    }

    const columns = preview.view.layout_manager._columns;
    const sameRow = Math.floor(preview.index / columns) === Math.floor(rawIndex / columns);

    const oldIndex = preview.index;
    const newIndex = sameRow ? oldIndex + Math.sign(rawIndex - oldIndex) : rawIndex;

    preview.index = newIndex;

    const lo = Math.min(oldIndex, newIndex);
    const hi = Math.max(oldIndex, newIndex);

    const moving = preview.order.slice(lo, hi).filter(Boolean);

    if (moving.length === 0) {
      this._advanceDragPreview();
      return;
    }

    preview.busy = true;
    let pending = moving.length;

    moving.forEach(icon => {
      const k = preview.order.indexOf(icon);
      const home = this._gridPosition(preview.view, this._previewSlot(k, preview.sourceHomeIndex));
      const to = this._gridPosition(preview.view, this._previewSlot(k, newIndex));

      icon.ease({
        translation_x: to.x - home.x,
        translation_y: to.y - home.y,
        duration: DRAG_FLIP_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          if (this._dragPreview !== preview) {
            return;
          }

          pending -= 1;

          if (pending === 0) {
            preview.busy = false;
            this._advanceDragPreview();
          }
        }
      });
    });
  }

  _clearDragPreview() {
    if (!this._dragPreview) {
      return;
    }

    this._dragPreview.order.forEach(icon => {
      icon.ease({
        translation_x: 0,
        translation_y: 0,
        duration: DRAG_FLIP_DURATION,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD
      });
    });

    this._dragPreview = null;
  }

  _onDrop(section, source, x, y) {
    this._clearDragPreview();
    this._stopAutoScroll();

    if (!this._isValidDragSource(source)) {
      return false;
    }

    const isFolder = source instanceof AppDisplay.FolderIcon;
    const sourceId = source.id;

    if (section === 'pinned' && isFolder) {
      return false;
    }

    const view = this._viewForSection(section);
    const target = this._getDropTarget(view, x, y);

    if (!isFolder && target.type === 'merge') {
      const targetIcon = target.icon;

      if (targetIcon instanceof AppDisplay.FolderIcon) {
        this.addAppToFolder(targetIcon.id, sourceId);
        return true;
      }

      if (targetIcon instanceof AppDisplay.AppIcon && targetIcon.id !== sourceId) {
        this._createFolderFromDrop(targetIcon.id, sourceId);
        return true;
      }
    }

    if (section === 'folders' && !isFolder) {
      return false;
    }

    if (section === 'folders') {
      this.reorderFolderEntry(sourceId, target.index);
      return true;
    }

    if (!isFolder) {
      this._removeAppFromFolder(sourceId, { silent: true });
    }

    if (section === 'pinned') {
      if (!this.isPinned(sourceId)) {
        this.togglePinned(sourceId);
      }

      this.reorderPinned(sourceId, target.index);
      return true;
    }

    if (this.isPinned(sourceId)) {
      this.togglePinned(sourceId);
    }

    const key = isFolder ? `folder:${sourceId}` : sourceId;
    this.reorderMainEntry(key, target.index);

    return true;
  }

  _getDropTarget(view, x, y) {
    const children = view.get_children();

    if (children.length === 0) {
      return { type: 'reorder', index: 0 };
    }

    // Figure out which icon the cursor is over from its row/column cell rather
    // than nearest-neighbor distance to every icon's center: distance-based lookup
    // gets genuinely ambiguous near a row boundary (a point between two rows can
    // be nearly equidistant from icons diagonally above and below it), which made
    // hovering near a row edge flicker between rows and drag multiple icons along
    // with it. Cell math has no such ambiguity, and it naturally leaves the
    // spacing gap between rows/columns belonging to the row/column before it, so
    // there's a dead zone before the cursor is unambiguously "in" the next row.
    const layout = view.layout_manager;
    const childSize = layout._getMinChildSize(children);
    const columns = layout._columns;
    const cellSize = childSize + layout._spacing;

    const col = Math.min(Math.max(Math.floor(x / cellSize), 0), columns - 1);
    const row = Math.max(Math.floor(y / cellSize), 0);

    const closestIndex = Math.min(row * columns + col, children.length - 1);
    const closestBox = children[closestIndex].get_allocation_box();

    const width = closestBox.get_width();
    const height = closestBox.get_height();
    const localX = x - closestBox.x1;
    const localY = y - closestBox.y1;

    const insideBox = localX >= 0 && localY >= 0 && localX <= width && localY <= height;

    if (insideBox) {
      const marginX = width * 0.15;
      const marginY = height * 0.15;

      const inHotZone = localX > marginX && localX < width - marginX &&
        localY > marginY && localY < height - marginY;

      if (inHotZone) {
        return { type: 'merge', icon: children[closestIndex], index: closestIndex };
      }
    }

    const before = localY < height / 2;
    return { type: 'reorder', index: before ? closestIndex : closestIndex + 1 };
  }

  _redisplay() {
    this._animateRedisplay(() => {
      this._redisplayLater = this._laters.add(Meta.LaterType.IDLE, () => {
        this._detachFolderIcons(this._pinnedView);
        this._detachFolderIcons(this._foldersView);
        this._detachFolderIcons(this._mainView);

        this._pinnedView.destroy_all_children();
        this._foldersView.destroy_all_children();
        this._mainView.destroy_all_children();

        this._addAppIcons();
        this._animateRedisplay();
      });
    });
  }

  _detachFolderIcons(view) {
    view.get_children()
      .filter(child => child instanceof AppDisplay.FolderIcon)
      .forEach(child => view.remove_child(child));
  }

  _animateRedisplay(onComplete) {
    this._scrollView.ease({
      onComplete,
      opacity: onComplete ? 0 : 255,
      duration: SIDE_CONTROLS_ANIMATION_TIME,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD
    });
  }

  _updateSectionSpacing() {
    const spacing = this._settings.get_int('icon-spacing');
    const style = `margin: 0 0 ${spacing}px 0;`;

    this._pinnedView.set_style(style);
    this._foldersView.set_style(style);
  }

  _updateIconSize() {
    const size = this._settings.get_int('icon-size');

    this._appIcons.forEach(appIcon => {
      appIcon.icon.setIconSize(size);
      delete appIcon._collapsedSize;
      delete appIcon._expandedSize;
    });
  }

  vfunc_key_press_event(event) {
    const key = event.get_key_symbol();
    const focused = global.stage.get_key_focus();

    if (key === Clutter.KEY_Escape) {
      return Clutter.EVENT_PROPAGATE;
    }

    const adjustment = this._scrollView.vadjustment;
    const pageSize = adjustment.page_size;

    const scroll = {
      [Clutter.KEY_Home]: 0,
      [Clutter.KEY_End]: adjustment.upper - pageSize,
      [Clutter.KEY_Page_Up]: this._scrollView.scroll - pageSize * 0.8,
      [Clutter.KEY_Page_Down]: this._scrollView.scroll + pageSize * 0.8
    };

    if (scroll[key] !== undefined) {
      return this._scrollView.scrollTo(scroll[key]);
    }

    const navTarget = this._getNavTarget(focused, key);

    if (navTarget) {
      this._scrollView.scrollToChild(navTarget);
      navTarget.grab_key_focus();

      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _getNavTarget(focused, key) {
    const index = this._appIcons.indexOf(focused);
    const last = this._appIcons.length - 1;

    let targetIndex = index;

    if (index === -1) {
      if (key === Clutter.KEY_Tab) {
        targetIndex = 0;
      } else if (key === Clutter.KEY_ISO_Left_Tab) {
        targetIndex = last;
      }
    } else {
      if (key === Clutter.KEY_Tab) {
        targetIndex = index < last ? index + 1 : 0;
      } else if (key === Clutter.KEY_ISO_Left_Tab) {
        targetIndex = index > 0 ? index - 1 : last;
      }
    }

    return this._appIcons[targetIndex];
  }

  destroy() {
    this._appSystem.disconnectObject(this);
    this._parentalControls.disconnectObject(this);
    this._overview.disconnectObject(this);
    this._settings.disconnectObject(this);
    this._folderSettings.disconnectObject(this);

    this._stopAutoScroll();

    if (this._redisplayLater) {
      this._laters.remove(this._redisplayLater);
    }

    this._folderIconCache.forEach(icon => icon.destroy());
    this._folderIconCache.clear();

    for (const appIcon of this._appIcons) {
      appIcon.destroy();
    }

    super.destroy();
  }
});

const VerticalScrollView = GObject.registerClass(
class VerticalScrollView extends St.ScrollView {
  _init(settings) {
    this._settings = settings;

    this._scroll = 0;
    this._trackpadTime = 0;

    this._scrollAnim = {
      lock: null,
      startTime: 0,
      startValue: 0,
      duration: 0,
      delta: 0
    };

    super._init({
      effect: new St.ScrollViewFade({
        fade_margins: new Clutter.Margin({
          top: 64,
          bottom: 64
        })
      }),
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.NEVER,
      x_expand: true,
      y_expand: true,
      reactive: true
    });

    this._scrollBox = new St.BoxLayout({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false,
      vertical: true
    });

    this.set_child(this._scrollBox);

    this._swipeTracker = new SwipeTracker(this, Clutter.Orientation.VERTICAL, Shell.ActionMode.OVERVIEW, {
      allowDrag: true,
      allowScroll: false
    });

    this._swipeTracker.connect('begin', this._onSwipeBegin.bind(this));
    this._swipeTracker.connect('update', this._onSwipeUpdate.bind(this));
    this._swipeTracker.connect('end', this._onSwipeEnd.bind(this));
  }

  add_child(child) {
    this._scrollBox.add_child(child);
  }

  _onSwipeBegin(tracker) {
    if (this._scrollAnim.lock) {
      this._scrollAnim.lock = global.stage.disconnect(this._scrollAnim.lock) || null;
    }

    const adjustment = this.vadjustment;

    this._swipeMin = adjustment.lower;
    this._swipeMax = adjustment.upper - adjustment.page_size;
    this._swipeLastProgress = this.scroll;
    this._swipeLastTime = GLib.get_monotonic_time();
    this._swipeVelocity = 0;

    tracker.confirmSwipe(1, [this._swipeMin, this._swipeMax], this.scroll, this.scroll);
  }

  _onSwipeUpdate(_tracker, progress) {
    const now = GLib.get_monotonic_time();
    const dt = Math.max(now - this._swipeLastTime, 1);

    this._swipeVelocity = (progress - this._swipeLastProgress) / dt;
    this._swipeLastProgress = progress;
    this._swipeLastTime = now;

    this.scrollTo(progress, false);
  }

  _onSwipeEnd(_tracker, _duration, _endProgress) {
    const flingDistance = this._swipeVelocity * 200;
    const target = Math.clamp(this.scroll + flingDistance, this._swipeMin, this._swipeMax);

    if (Math.abs(flingDistance) > 2) {
      this.scrollTo(target, true, 300);
    }
  }

  scrollToChild(child) {
    const childBox = child.get_allocation_box();

    let actor = child;
    let childY = childBox.y1;

    while ((actor = actor.get_parent()) !== this) {
      childY += actor.get_allocation_box().y1;
    }

    const adjustment = this.vadjustment;

    const childCenter = childY + childBox.get_height() / 2;
    const scroll = childCenter - adjustment.page_size / 2;

    this.scrollTo(scroll);
  }

  scrollTo(scroll, animate = true, duration = 200) {
    const now = GLib.get_monotonic_time();

    const adjustment = this.vadjustment;
    const anim = this._scrollAnim;

    const min = adjustment.lower;
    const max = adjustment.upper - adjustment.page_size;

    const scrollClamped = Math.clamp(scroll, min, max);
    const distance = Math.abs(this.scroll - scrollClamped);

    if (distance === 0) {
      return Clutter.EVENT_STOP;
    }

    this._scroll = scrollClamped;

    if (animate) {
      anim.startTime = now;
      anim.startValue = adjustment.value;
      anim.delta = this.scroll - adjustment.value;

      if (anim.lock === null) {
        anim.lock = global.stage.connect('after-paint', this._scrollAnimationFrame.bind(this));
        anim.duration = duration * 1000;
      }
    } else {
      if (anim.lock) {
        anim.lock = global.stage.disconnect(anim.lock) || null;
      }

      adjustment.value = this.scroll;
    }

    this.queue_redraw();

    return Clutter.EVENT_STOP;
  }

  _scrollAnimationFrame() {
    const now = GLib.get_monotonic_time();

    const adjustment = this.vadjustment;
    const anim = this._scrollAnim;

    const elapsed = now - anim.startTime;
    const progress = Math.clamp(elapsed / anim.duration, 0, 1);

    adjustment.value = anim.startValue + anim.delta * easeOutCubic(progress);

    if (progress >= 1) {
      anim.lock = global.stage.disconnect(anim.lock) || null;
    }

    this.queue_redraw();
  }

  vfunc_scroll_event(event) {
    if (this._settings.get_boolean('animate-scroll')) {
      return this._animateScroll(event);
    }

    return super.vfunc_scroll_event(event);
  }

  _animateScroll(event) {
    const now = GLib.get_monotonic_time();

    if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED) {
      return Clutter.EVENT_STOP;
    }

    const adjustment = this.vadjustment;

    const direction = event.get_scroll_direction();
    const step = adjustment.page_size ** (2 / 3);

    let delta = 0;
    let animate = false;

    if (direction === Clutter.ScrollDirection.SMOOTH) {
      this._trackpadTime = now;

      delta = event.get_scroll_delta()[Clutter.Orientation.VERTICAL] ?? 0;
    } else if (now - this._trackpadTime > 1000 * 1000) {
      if (direction === Clutter.ScrollDirection.UP) {
        delta = -1;
      } else if (direction === Clutter.ScrollDirection.DOWN) {
        delta = 1;
      }

      animate = true;
    }

    const min = adjustment.lower;
    const max = adjustment.upper - adjustment.page_size;

    const clampedScroll = Math.clamp(this.scroll + delta * step, min, max);
    const distance = Math.abs(this.scroll - clampedScroll);
    const duration = (distance / 100) * 200;

    if (distance === 0) {
      return Clutter.EVENT_STOP;
    }

    return this.scrollTo(clampedScroll, animate, duration);
  }

  destroy() {
    if (this._scrollAnim.lock) {
      global.stage.disconnect(this._scrollAnim.lock);
    }
  }

  get scroll() {
    return this._scroll;
  }
});

const VerticalLayout = GObject.registerClass(
class VerticalLayout extends Clutter.LayoutManager {
  _init(settings) {
    super._init();

    this._settings = settings;

    settings.connectObject('changed', (_settings, key) => {
      if (['columns', 'icon-spacing'].includes(key)) {
        this._columns = settings.get_int('columns');
        this._spacing = settings.get_int('icon-spacing');

        this.layout_changed();
      }
    }, this);

    this._columns = settings.get_int('columns');
    this._spacing = settings.get_int('icon-spacing');
  }

  vfunc_get_preferred_width(container, _forHeight) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);

    const columns = Math.min(children.length, this._columns);
    const size = columns * childSize + (columns - 1) * this._spacing;

    if (columns) {
      return [size, size];
    }

    return [0, 0];
  }

  vfunc_get_preferred_height(container, _forWidth) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);

    const rows = Math.ceil(children.length / this._columns);
    const size = rows * childSize + (rows - 1) * this._spacing;

    if (rows) {
      return [size, size];
    }

    return [0, 0];
  }

  vfunc_allocate(container, _box) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);

    const childBox = new Clutter.ActorBox();

    for (let i = 0; i < children.length; i++) {
      const col = i % this._columns;
      const row = Math.floor(i / this._columns);

      const x = col * (childSize + this._spacing);
      const y = row * (childSize + this._spacing);

      childBox.set_origin(
        Math.floor(x),
        Math.floor(y)
      );

      const height = children[i]._hoverExpanded
        ? Math.max(childSize, this._getExpandedChildSize(children[i]))
        : childSize;

      childBox.set_size(childSize, height);

      children[i].allocate(childBox);
    }
  }

  // Only ever called for the one icon currently expanded on hover (rare, one
  // at a time), so — unlike _getMinChildSize below — there's no need to cache
  // this ahead of time to avoid repeated work on every layout pass. The
  // label is already genuinely in its expanded state by the time this runs
  // (set by the hover handler before it triggers this relayout), so this
  // measures it as-is rather than needing to fake that state first.
  _getExpandedChildSize(icon) {
    if (icon._expandedSize === undefined) {
      const [, naturalHeight] = icon.get_preferred_height(this._settings.get_int('icon-size'));
      icon._expandedSize = naturalHeight;
    }

    return icon._expandedSize;
  }

  _getMinChildSize(children) {
    let size = 0;

    children.forEach(child => {
      // Cache each icon's natural size the first time it's actually needed
      // here — not any earlier, since a freshly-created icon isn't
      // parented/styled yet at that point and would measure as 0 — and never
      // again after that, since re-measuring on every layout pass is what
      // made dragging/scrolling laggy. This reads whatever state the label
      // is actually in, which by construction is always its default
      // collapsed (single-line, ellipsized) state at this point — the label
      // only ever expands transiently on hover, well after this first runs,
      // and that expansion is deliberately not reflected in the shared grid
      // cell size (it overflows past its box instead) so hovering one icon
      // doesn't resize every icon in the grid.
      if (child._collapsedSize === undefined) {
        const [, naturalHeight] = child.get_preferred_height(-1);
        const [, naturalWidth] = child.get_preferred_width(-1);

        child._collapsedSize = Math.max(naturalHeight, naturalWidth);
      }

      size = Math.max(size, child._collapsedSize);
    });

    return size;
  }

  destroy() {
    this._settings.disconnectObject(this);
  }
});
