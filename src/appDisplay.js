import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { SIDE_CONTROLS_ANIMATION_TIME } from 'resource:///org/gnome/shell/ui/overviewControls.js';

import { findDuplicateApps, getAppSourceName } from './appSource.js';

// Distance from the top or bottom edge where dragging an app scrolls the grid
const DRAG_SCROLL_EDGE = 80;

function easeOutCubic(t) {
  return (--t) * t * t + 1;
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

    this._favoritesLabel = new St.Label({
      style_class: 'search-statustext',
      text: _('Favorites')
    });

    this._favoritesView = new St.Viewport({
      layout_manager: new VerticalLayout(settings)
    });

    this._foldersLabel = new St.Label({
      style_class: 'search-statustext',
      text: _('Folders')
    });

    this._foldersView = new St.Viewport({
      layout_manager: new VerticalLayout(settings)
    });

    this._mainLabel = new St.Label({
      style_class: 'search-statustext',
      text: _('All Apps')
    });

    this._mainView = new St.Viewport({
      layout_manager: new VerticalLayout(settings)
    });

    this._scrollView = new VerticalScrollView(settings);

    this._scrollView.add_child(this._favoritesLabel);
    this._scrollView.add_child(this._favoritesView);
    this._scrollView.add_child(this._foldersLabel);
    this._scrollView.add_child(this._foldersView);
    this._scrollView.add_child(this._mainLabel);
    this._scrollView.add_child(this._mainView);

    this.add_child(this._scrollView);

    this._appSystem = Shell.AppSystem.get_default();
    this._appUsage = Shell.AppUsage.get_default();
    this._appFavorites = AppFavorites.getAppFavorites();
    this._parentalControls = ParentalControlsManager.getDefault();
    this._overview = Main.overview;

    // Receives apps dragged out of a folder dialog
    this._delegate = this;

    this._folderSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
    this._folderIcons = new Map();
    this._folderApps = new Map();
    this._sourceBadges = new WeakMap();
    this._folderMenuItems = new WeakMap();
    this._menuIcons = new WeakSet();
    this._duplicates = new Set();

    this._connectSignals();
    this._addAppIcons();
  }

  _connectSignals() {
    // Redisplay the app grid when an app was installed or removed
    this._appSystem.connectObject('installed-changed', () => {
      this._redisplay();
    }, this);

    // Redisplay when folders are created or deleted
    this._folderSettings.connectObject('changed::folder-children', () => {
      this._redisplay(false);
    }, this);

    // Redisplay when favorites change
    this._appFavorites.connectObject('changed', () => {
      this._redisplay();
    }, this);

    // Redisplay when parental controls change
    this._parentalControls.connectObject('app-filter-changed', () => {
      this._redisplay();
    }, this);

    // Reset scroll when the overview is hidden
    this._overview.connectObject('hidden', () => {
      this._scrollView.scrollTo(0, false);
    }, this);

    // Scroll the grid while an app is dragged near its edges, so that the
    // folders stay reachable from anywhere in the list
    this._overview.connectObject(
      'item-drag-begin', () => this._onDragBegin(),
      'item-drag-end', () => this._onDragEnd(),
      'item-drag-cancelled', () => this._onDragEnd(),
      this);

    // Update layout when settings change
    this._settings.connectObject('changed', (_, key) => {
      switch (key) {
        case 'app-sorting':
        case 'favorites-section':
        case 'show-labels':
        case 'favorites-sorting':
        case 'folders-section':
        case 'duplicate-badges':
        case 'source-badges':
          return this._redisplay();

        case 'icon-spacing':
          return this._updateLabelMargins();

        case 'icon-size':
          return this._updateIconSize();
      }
    }, this);
  }

  _addAppIcons() {
    const iconSize = this._settings.get_int('icon-size');
    const favSection = this._settings.get_boolean('favorites-section');
    const showLabels = this._settings.get_boolean('show-labels');
    const isDraggable = global.settings.is_writable('favorite-apps') || global.settings.is_writable('app-picker-layout');

    const apps = this._loadApps().map(appId => this._appSystem.lookup_app(appId));
    this._duplicates = this._settings.get_boolean('duplicate-badges') ? findDuplicateApps(apps) : new Set();

    const folderIcons = this._loadFolderIcons();
    const appsInFolders = new Set(folderIcons.flatMap(folderIcon => folderIcon.getAppIds()));

    folderIcons.forEach(folderIcon => {
      folderIcon.icon.setIconSize(iconSize);
      folderIcon.icon.label.visible = showLabels;

      this._foldersView.add_child(folderIcon);
    });

    this._appIcons = apps.filter(app => !appsInFolders.has(app.get_id())).map(app => {
      const appIcon = new AppDisplay.AppIcon(app, { isDraggable, showLabel: showLabels })
      const isFav = this._appFavorites.isFavorite(app.get_id());

      appIcon.icon.setIconSize(iconSize);

      this._updateSourceBadge(appIcon);
      this._makeFolderDropTarget(appIcon);

      this._addFolderMenu(appIcon, null);

      if (favSection && isFav) {
        this._favoritesView.add_child(appIcon);
      } else {
        this._mainView.add_child(appIcon);
      }

      return appIcon;
    });

    // Keyboard navigation follows the order of the sections
    this._navIcons = [this._favoritesView, this._foldersView, this._mainView].flatMap(view => view.get_children());

    const showFavSection = this._favoritesView.get_children().length > 0;
    const showFoldersSection = this._foldersView.get_children().length > 0;
    const showMainSection = this._mainView.get_children().length > 0;
    const showMainLabel = (showFavSection || showFoldersSection) && showMainSection;

    this._favoritesLabel.visible = showFavSection;
    this._favoritesView.visible = showFavSection;
    this._foldersLabel.visible = showFoldersSection;
    this._foldersView.visible = showFoldersSection;
    this._mainLabel.visible = showMainLabel;
    this._mainView.visible = showMainSection;

    this._updateLabelMargins();
  }

  _updateSourceBadge(appIcon) {
    const isDuplicate = this._duplicates.has(appIcon.id);

    this._sourceBadges.get(appIcon)?.destroy();
    this._sourceBadges.delete(appIcon);

    if (!isDuplicate && !this._settings.get_boolean('source-badges')) {
      return;
    }

    const badge = new St.Label({
      style_class: isDuplicate ? 'vertical-app-grid-badge duplicate' : 'vertical-app-grid-badge',
      text: getAppSourceName(appIcon.app.app_info),
      x_align: Clutter.ActorAlign.CENTER
    });

    // The badge goes below the app name, inside the icon's own box
    appIcon.icon._box.add_child(badge);
    this._sourceBadges.set(appIcon, badge);
  }

  // The shell only accepts drops between icons of its own app grid, so the
  // checks are replaced to accept the icons of the vertical grid instead.
  // Icons inside folder dialogs are excluded, as in the default grid.
  _makeFolderDropTarget(appIcon) {
    appIcon._canAccept = source => source !== appIcon && this._appIcons.includes(source);

    appIcon.acceptDrop = (source, _actor, x) => {
      appIcon._setHoveringByDnd(false);

      if (!appIcon._canAccept(source) || appIcon._withinLeeways(x)) {
        return false;
      }

      this._createFolder([appIcon.id, source.id]);
      return true;
    };
  }

  _onDragBegin() {
    this._onDragEnd();

    this._dragMonitor = {
      dragMotion: this._onDragMotion.bind(this)
    };

    DND.addDragMonitor(this._dragMonitor);
  }

  _onDragMotion(dragEvent) {
    const [, x, y] = this._scrollView.transform_stage_point(dragEvent.x, dragEvent.y);
    const { width, height } = this._scrollView;

    // Drags started from the dash in the window picker, or moving over the
    // dash, must not scroll the grid
    if (!this._scrollView.mapped || x < 0 || x > width || y < 0 || y > height) {
      this._dragScrollSpeed = 0;
    } else if (y < DRAG_SCROLL_EDGE) {
      this._dragScrollSpeed = (y - DRAG_SCROLL_EDGE) / 4;
    } else if (y > height - DRAG_SCROLL_EDGE) {
      this._dragScrollSpeed = (y - height + DRAG_SCROLL_EDGE) / 4;
    } else {
      this._dragScrollSpeed = 0;
    }

    if (this._dragScrollSpeed && !this._dragScrollId) {
      this._dragScrollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        const adjustment = this._scrollView.vadjustment;

        adjustment.value = Math.clamp(adjustment.value + this._dragScrollSpeed,
          adjustment.lower, adjustment.upper - adjustment.page_size);

        if (this._dragScrollSpeed) {
          return GLib.SOURCE_CONTINUE;
        }

        this._dragScrollId = 0;
        return GLib.SOURCE_REMOVE;
      });
    }

    return DND.DragMotionResult.CONTINUE;
  }

  _onDragEnd() {
    if (this._dragMonitor) {
      DND.removeDragMonitor(this._dragMonitor);
      this._dragMonitor = null;
    }

    if (this._dragScrollId) {
      GLib.Source.remove(this._dragScrollId);
      this._dragScrollId = 0;
    }
  }

  // The menu of an app is created when it is first opened
  _addFolderMenu(appIcon, folderId) {
    if (this._menuIcons.has(appIcon)) {
      return;
    }

    this._menuIcons.add(appIcon);

    appIcon.connect('menu-state-changed', (_icon, opened) => {
      if (opened) {
        this._updateFolderMenu(appIcon, folderId);
      }
    });
  }

  // Adds a "Move to Folder" submenu to the app menu, below the favorites item.
  // Apps inside a folder can also be moved to another folder or out of it.
  _updateFolderMenu(appIcon, folderId) {
    const menu = appIcon._menu;
    let item = this._folderMenuItems.get(menu);

    if (!item) {
      item = new PopupMenu.PopupSubMenuMenuItem(_('Move to Folder'));
      menu.addMenuItem(item, menu._getMenuItems().indexOf(menu._toggleFavoriteItem) + 1);
      this._folderMenuItems.set(menu, item);
    }

    item.visible = this._settings.get_boolean('folders-section');
    item.menu.removeAll();

    const folders = [...this._folderIcons]
      .filter(([id, folderIcon]) => id !== folderId && folderIcon.visible)
      .sort(([, a], [, b]) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    // Folders are looked up again when an item is chosen, as they may have
    // been rebuilt while the menu was open
    folders.forEach(([id, folderIcon]) => {
      item.menu.addAction(folderIcon.name, () => {
        this._removeFromFolder(appIcon, folderId);
        this._folderIcons.get(id)?.view.addApp(appIcon.app);
        this._removeFavorite(appIcon.id);
      });
    });

    if (folders.length > 0) {
      item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
    }

    item.menu.addAction(_('New Folder'), () => {
      this._removeFromFolder(appIcon, folderId);
      this._createFolder([appIcon.id]);
    });

    if (folderId) {
      item.menu.addAction(_('Remove from Folder'), () => this._removeFromFolder(appIcon, folderId));
    }
  }

  _removeFromFolder(appIcon, folderId) {
    if (folderId) {
      this._folderIcons.get(folderId)?.view.removeApp(appIcon);
    }
  }

  _createFolder(appIds) {
    const id = GLib.uuid_string_random();
    const folder = new Gio.Settings({
      schema_id: 'org.gnome.desktop.app-folders.folder',
      path: this._getFolderPath(id)
    });

    folder.set_string('name', _('New Folder'));
    folder.set_strv('apps', appIds);

    appIds.forEach(appId => this._removeFavorite(appId));
    this._folderSettings.set_strv('folder-children', [...this._folderSettings.get_strv('folder-children'), id]);
  }

  // Folders never show favorites, so a favorite moved into a folder stops being one
  _removeFavorite(appId) {
    if (this._appFavorites.isFavorite(appId)) {
      this._appFavorites.removeFavorite(appId);
    }
  }

  _getFolderPath(id) {
    return `${this._folderSettings.path}folders/${id}/`;
  }

  _loadFolderIcons() {
    const folderIds = this._settings.get_boolean('folders-section')
      ? this._folderSettings.get_strv('folder-children')
      : [];

    for (const id of this._folderIcons.keys()) {
      if (!folderIds.includes(id)) {
        this._folderIcons.get(id).destroy();
        this._folderIcons.delete(id);
        this._folderApps.delete(id);
      }
    }

    const folderIcons = folderIds.map(id => {
      if (!this._folderIcons.has(id)) {
        const folderIcon = new AppDisplay.FolderIcon(id, this._getFolderPath(id), this);

        // Folder icons are reused between redisplays, so renaming a folder
        // must not rebuild the grid and close the open folder dialog
        folderIcon.connectObject('apps-changed', () => {
          // The folder view does not reload its apps on its own
          folderIcon.view._redisplay();

          const appIds = folderIcon.getAppIds().join();

          if (this._folderApps.get(id) !== appIds) {
            this._folderApps.set(id, appIds);
            this._redisplay(false);
          }
        }, this);

        folderIcon._canAccept = source => this._appIcons.includes(source);

        folderIcon.acceptDrop = (source, actor, x) => {
          const accepted = AppDisplay.FolderIcon.prototype.acceptDrop.call(folderIcon, source, actor, x);

          if (accepted) {
            this._removeFavorite(source.id);
          }

          return accepted;
        };

        this._folderIcons.set(id, folderIcon);
        this._folderApps.set(id, folderIcon.getAppIds().join());
      }

      const folderIcon = this._folderIcons.get(id);

      folderIcon.view._redisplay();
      folderIcon.view.getAllItems().forEach(appIcon => {
        this._updateSourceBadge(appIcon);
        this._addFolderMenu(appIcon, id);
      });

      return folderIcon;
    });

    return folderIcons
      .filter(folderIcon => folderIcon.visible)
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }

  // FolderIcon, FolderView and AppFolderDialog expect their parent view to
  // provide these methods, normally implemented by the default app display
  getAppInfos() {
    return this._appSystem.get_installed().filter(appInfo => {
      try {
        appInfo.get_id();
      } catch {
        return false;
      }

      return !this._appFavorites.isFavorite(appInfo.get_id()) && this._parentalControls.shouldShowApp(appInfo);
    });
  }

  addFolderDialog(dialog) {
    Main.layoutManager.overviewGroup.add_child(dialog);
  }

  selectApp(appId) {
    const appIcon = this._navIcons.find(icon => icon.id === appId);

    if (appIcon) {
      this._scrollView.scrollToChild(appIcon);
      appIcon.grab_key_focus();
    }
  }

  _findFolderIcon(appIcon) {
    return [...this._folderIcons.values()].find(folderIcon => folderIcon.view.getAllItems().includes(appIcon));
  }

  handleDragOver(source) {
    return this._findFolderIcon(source) ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.CONTINUE;
  }

  acceptDrop(source) {
    const folderIcon = this._findFolderIcon(source);

    if (!folderIcon) {
      return false;
    }

    folderIcon.view.removeApp(source);
    return true;
  }

  _loadApps() {
    const installedApps = this._appSystem.get_installed();

    const favs = [];
    const apps = [];

    // Filter out hidden apps and split off favorites
    const favSection = this._settings.get_boolean('favorites-section');

    installedApps.forEach(appInfo => { try {
      const appId = appInfo.get_id();
      const isFav = this._appFavorites.isFavorite(appId);

      if (this._parentalControls.shouldShowApp(appInfo)) {
        if (favSection && isFav) {
          favs.push(appInfo);
        } else {
          apps.push(appInfo);
        }
      }
    } catch { } });

    // Sort favorites
    const favSorting = this._settings.get_string('favorites-sorting');
    const favIds = this._appFavorites._getIds();

    favs.sort((a, b) => {
      switch (favSorting) {
        case 'dash':
          return favIds.indexOf(a.get_id()) - favIds.indexOf(b.get_id());

        case 'usage':
          return this._appUsage.compare(a.get_id(), b.get_id()) ?? 0;

        case 'alphabetical': default:
          return a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase());
      }
    });

    // Sort apps
    const appSorting = this._settings.get_string('app-sorting');

    apps.sort((a, b) => {
      switch (appSorting) {
        case 'usage':
          return this._appUsage.compare(a.get_id(), b.get_id()) ?? 0;

        case 'alphabetical': default:
          return a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase());
      }
    });

    return [...favs, ...apps].map(appInfo => appInfo.get_id());
  }

  // Folder changes made by the user redisplay without fading the grid out,
  // so moving an app into a folder does not make the whole view blink
  _redisplay(animate = true) {
    const rebuild = () => {
      if (this._redisplayLater) {
        return;
      }

      this._redisplayLater = this._laters.add(Meta.LaterType.IDLE, () => {
        this._redisplayLater = 0;

        this._favoritesView.destroy_all_children();
        this._foldersView.remove_all_children();
        this._mainView.destroy_all_children();

        this._addAppIcons();

        // A fade out may have finished while this rebuild was pending
        if (this._scrollView.opacity < 255) {
          this._animateRedisplay();
        }
      });
    };

    if (animate) {
      this._animateRedisplay(rebuild);
    } else {
      rebuild();
    }
  }

  _animateRedisplay(onComplete) {
    this._scrollView.ease({
      onComplete,
      opacity: onComplete ? 0 : 255,
      duration: SIDE_CONTROLS_ANIMATION_TIME,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD
    });
  }

  _updateLabelMargins() {
    const spacing = this._settings.get_int('icon-spacing');

    const foldersTop = this._favoritesLabel.visible ? spacing * 2 : 0;

    this._favoritesLabel.set_style(`margin: 0 0 ${spacing}px 0;`);
    this._foldersLabel.set_style(`margin: ${foldersTop}px 0 ${spacing}px 0;`);
    this._mainLabel.set_style(`margin: ${spacing * 2}px 0 ${spacing}px 0;`);
  }

  _updateIconSize() {
    const size = this._settings.get_int('icon-size');

    this._navIcons.forEach(appIcon => {
      appIcon.icon.setIconSize(size);
    });
  }

  vfunc_key_press_event(event) {
    const key = event.get_key_symbol();
    const focused = global.stage.get_key_focus();

    if (key === Clutter.KEY_Escape) {
      return Clutter.EVENT_PROPAGATE;
    }

    // Keyboard scroll
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

    // Tab and arrow key navigation
    const navTarget = this._getNavTarget(focused, key);

    if (navTarget) {
      this._scrollView.scrollToChild(navTarget);
      navTarget.grab_key_focus();

      return Clutter.EVENT_STOP;
    }

    return Clutter.EVENT_PROPAGATE;
  }

  _getNavTarget(focused, key) {
    const index = this._navIcons.indexOf(focused);
    const last = this._navIcons.length - 1;

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

    return this._navIcons[targetIndex];
  }

  destroy() {
    this._appSystem.disconnectObject(this);
    this._appFavorites.disconnectObject(this);
    this._parentalControls.disconnectObject(this);
    this._overview.disconnectObject(this);
    this._settings.disconnectObject(this);
    this._folderSettings.disconnectObject(this);

    if (this._redisplayLater) {
      this._laters.remove(this._redisplayLater);
    }

    this._onDragEnd();

    for (const folderIcon of this._folderIcons.values()) {
      folderIcon.destroy();
    }

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
      y_expand: true
    });

    this._scrollBox = new St.BoxLayout({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false,
      orientation: Clutter.Orientation.VERTICAL
    });

    this.set_child(this._scrollBox);
  }

  add_child(child) {
    this._scrollBox.add_child(child);
  }

  scrollToChild(child) {
    const childBox = child.get_allocation_box();

    // Get the child's vertical position inside the scroll view
    let actor = child;
    let childY = childBox.y1;

    while ((actor = actor.get_parent()) !== this) {
      childY += actor.get_allocation_box().y1;
    }

    // Scroll to keep the child vertically centered
    const adjustment = this.vadjustment;

    const childCenter = childY + childBox.get_height() / 2;
    const scroll = childCenter - adjustment.page_size / 2;

    this.scrollTo(scroll);
  }

  scrollTo(scroll, animate = true, duration = 200) {
    const now = GLib.get_monotonic_time();

    const adjustment = this.vadjustment;
    const anim = this._scrollAnim;

    // Only scroll if the clamped distance is greater than zero to prevent
    // rapidly retriggering the animation while holding down a key
    const min = adjustment.lower;
    const max = adjustment.upper - adjustment.page_size;

    const scrollClamped = Math.clamp(scroll, min, max);
    const distance = Math.abs(this.scroll - scrollClamped);

    if (distance === 0) {
      return Clutter.EVENT_STOP;
    }

    this._scroll = scrollClamped;

    if (animate) {
      // Init scroll animation
      anim.startTime = now;
      anim.startValue = adjustment.value;
      anim.delta = this.scroll - adjustment.value;

      if (anim.lock === null) {
        anim.lock = global.stage.connect('after-paint', this._scrollAnimationFrame.bind(this));
        anim.duration = duration * 1000;
      }
    } else {
      // Cancel running animation
      if (anim.lock) {
        anim.lock = global.stage.disconnect(anim.lock) || null;
      }

      adjustment.value = this.scroll;
    }

    // Redraw to trigger the next animation frame
    this.queue_redraw();

    return Clutter.EVENT_STOP;
  }

  _scrollAnimationFrame() {
    const now = GLib.get_monotonic_time();

    const adjustment = this.vadjustment;
    const anim = this._scrollAnim;

    // Animate towards the scroll target
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

    // Ignore emulated events
    if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED) {
      return Clutter.EVENT_STOP;
    }

    // Get scroll delta
    const adjustment = this.vadjustment;

    const direction = event.get_scroll_direction();
    const step = adjustment.page_size ** (2 / 3);

    let delta = 0;
    let animate = false;

    if (direction === Clutter.ScrollDirection.SMOOTH) {
      // Sometimes events without a smooth delta are emitted when using a
      // trackpad, so this debounce timestamp is used to prevent any sudden
      // jumps while scrolling
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

    // Animate to the new scroll position
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

    settings.connectObject('changed', (_, key) => {
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

      const [_minWidth, _minHeight,
        naturalWidth, naturalHeight] = children[i].get_preferred_size();

      childBox.set_origin(
        Math.floor(x),
        Math.floor(y)
      );

      childBox.set_size(
        Math.max(childSize, naturalWidth),
        Math.max(childSize, naturalHeight)
      );

      children[i].allocate(childBox);
    }
  }

  _getMinChildSize(children) {
    let minWidth = 0;
    let minHeight = 0;

    children.forEach(child => {
      const childMinHeight = child.get_preferred_height(-1)[0];
      const childMinWidth = child.get_preferred_width(-1)[0];

      minWidth = Math.max(minWidth, childMinWidth);
      minHeight = Math.max(minHeight, childMinHeight);
    });

    return Math.max(minWidth, minHeight);
  }

  destroy() {
    this._settings.disconnectObject(this);
  }
});
