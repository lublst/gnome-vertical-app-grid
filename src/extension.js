import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

import { VerticalAppDisplay } from './appDisplay.js';

export default class VerticalAppGridExtension extends Extension {
  enable() {
    const extension = this;

    this._enabled = false;
    this._originalStates = new Map();

    if (!this._checkCompatibility()) {
      console.warn('[vertical-app-grid-max] Shell internals this extension relies on ' +
        '(Main.overview._overview._controls.appDisplay and friends) don\'t look the ' +
        'way this version of the extension expects -- probably a GNOME Shell update ' +
        'changed something upstream. Staying inactive rather than risking a crash; ' +
        'please file an issue with your shell version.');
      return;
    }

    const overviewControlsProto = OverviewControls.ControlsManager.prototype;

    this._settings = this.getSettings();
    this._vertAppDisplay = new VerticalAppDisplay(this._settings);
    this._injectionManager = new InjectionManager();

    this._overviewControls = Main.overview._overview._controls;
    this._overviewLayoutManager = this._overviewControls.layout_manager;

    this._originalStates.set('layoutManagerAppDisplay', this._overviewLayoutManager._appDisplay);

    const addedOk = this._safeExecute(() => {
      this._overviewControls.add_child(this._vertAppDisplay);

      this._overviewLayoutManager._appDisplay = this._vertAppDisplay;
    }, 'adding the vertical app display to the overview');

    if (!addedOk) {
      this._vertAppDisplay.destroy();
      this._vertAppDisplay = null;
      this._settings = null;
      this._injectionManager = null;
      return;
    }

    this._safeExecute(() => {
      this._injectionManager.overrideMethod(overviewControlsProto, '_updateAppDisplayVisibility', () => function (params = null) {
        if (!params) {
          params = this._stateAdjustment.getStateTransitionParams();
        }

        const { initialState, finalState } = params;
        const state = Math.max(initialState, finalState);

        extension._vertAppDisplay.visible =
          state > OverviewControls.ControlsState.WINDOW_PICKER &&
          !this._searchController.searchActive;

        if (extension._vertAppDisplay.visible) {
          global.stage.set_key_focus(extension._vertAppDisplay);
        }

        extension._safeExecute(() => extension._overviewControls.appDisplay._disconnectDnD(),
          'disconnecting DnD from the original app grid');
      });
    }, 'overriding _updateAppDisplayVisibility');

    this._safeExecute(() => {
      this._injectionManager.overrideMethod(overviewControlsProto, '_onSearchChanged', originalFn => function () {
        originalFn.call(this);

        const { searchActive } = this._searchController;

        extension._vertAppDisplay.ease({
          opacity: searchActive ? 0 : 255,
          duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
          mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
      });
    }, 'overriding _onSearchChanged');

    this._safeExecute(() => {
      this._injectionManager.overrideMethod(AppMenu.AppMenu.prototype, '_updateFavoriteItem', originalFn => function () {
        originalFn.call(this);

        if (this._toggleFavoriteItem.visible) {
          const text = this._appFavorites.isFavorite(this._app.id)
            ? _('Remove from Favorites')
            : _('Add to Favorites');

          this._toggleFavoriteItem.label.text = text;
        }

        extension._updateAppMenuExtras(this);
      });
    }, 'overriding AppMenu._updateFavoriteItem');

    this._enabled = true;
  }

  _checkCompatibility() {
    const controls = Main.overview?._overview?._controls;

    const looksRight = !!(
      controls &&
      controls.layout_manager &&
      controls.appDisplay &&
      typeof controls.appDisplay._disconnectDnD === 'function' &&
      typeof controls.appDisplay._connectDnD === 'function' &&
      typeof controls.add_child === 'function'
    );

    return looksRight;
  }

  _safeExecute(callback, description) {
    try {
      callback();
      return true;
    } catch (error) {
      logError(error, `[vertical-app-grid-max] failed while ${description}`);
      return false;
    }
  }

  _updateAppMenuExtras(appMenu) {
    const display = this._vertAppDisplay;
    const appId = appMenu._app?.id;

    if (!display || !appId) {
      return;
    }

    this._safeExecute(() => {
      if (!appMenu._pinItem) {
        appMenu._pinItem = appMenu.addAction('', () => {
          display.togglePinned(appId);
        });
      }

      appMenu._pinItem.label.text = display.isPinned(appId)
        ? _('Unpin from Drawer')
        : _('Pin to Drawer');

      if (!appMenu._hideItem) {
        appMenu._hideItem = appMenu.addAction('', () => {
          display.toggleHidden(appId);
        });
      }

      appMenu._hideItem.label.text = display.isHidden(appId)
        ? _('Show in Drawer')
        : _('Hide from Drawer');

      if (!appMenu._folderSubMenu) {
        appMenu._folderSubMenu = new PopupMenu.PopupSubMenuMenuItem(_('Add to Folder'));
        appMenu.addMenuItem(appMenu._folderSubMenu);
      }

      appMenu._folderSubMenu.menu.removeAll();

      const folders = display.getFolders();
      const currentFolderId = display.getAppFolder(appId);

      Object.entries(folders).forEach(([id, folder]) => {
        if (id === currentFolderId) {
          return;
        }

        appMenu._folderSubMenu.menu.addAction(folder.name, () => {
          display.addAppToFolder(id, appId);
        });
      });

      appMenu._folderSubMenu.menu.addAction(_('New Folder\u2026'), () => {
        display.promptNewFolder(appId);
      });

      if (currentFolderId) {
        if (!appMenu._removeFromFolderItem) {
          appMenu._removeFromFolderItem = appMenu.addAction(_('Remove from Folder'), () => {
            display.removeAppFromFolder(appId);
          });
        }

        appMenu._removeFromFolderItem.visible = true;
      } else if (appMenu._removeFromFolderItem) {
        appMenu._removeFromFolderItem.visible = false;
      }
    }, 'building app menu extras');
  }

  disable() {
    if (!this._enabled) {
      this._originalStates = null;
      return;
    }

    if (this._overviewLayoutManager) {
      this._safeExecute(() => {
        this._overviewLayoutManager._appDisplay = this._originalStates.get('layoutManagerAppDisplay');
      }, 'restoring the original app display layout');
    }

    if (this._overviewControls && this._vertAppDisplay) {
      this._safeExecute(() => {
        this._overviewControls.remove_child(this._vertAppDisplay);
      }, 'removing the vertical app display from the overview');
    }

    this._injectionManager?.clear();
    this._vertAppDisplay?.destroy();

    if (this._overviewControls?.appDisplay) {
      this._safeExecute(() => {
        this._overviewControls.appDisplay._disconnectDnD();
        this._overviewControls.appDisplay._connectDnD();
      }, 'restoring DnD on the original app grid');
    }

    this._settings = null;
    this._vertAppDisplay = null;
    this._injectionManager = null;
    this._overviewControls = null;
    this._overviewLayoutManager = null;
    this._originalStates = null;
    this._enabled = false;
  }
}
