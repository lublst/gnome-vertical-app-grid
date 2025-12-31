import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppMenu from 'resource:///org/gnome/shell/ui/appMenu.js';
import * as OverviewControls from 'resource:///org/gnome/shell/ui/overviewControls.js';

import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import { InjectionManager } from 'resource:///org/gnome/shell/extensions/extension.js';

import { VerticalAppDisplay } from './appDisplay.js';

export default class VerticalAppGridExtension extends Extension {
  enable() {
    const extension = this;
    const overviewControlsProto = OverviewControls.ControlsManager.prototype;

    this._settings = this.getSettings();
    this._vertAppDisplay = new VerticalAppDisplay(this._settings);
    this._injectionManager = new InjectionManager();

    // Add the vertical app display to the overview
    this._overviewControls = Main.overview._overview._controls;
    this._overviewLayoutManager = this._overviewControls.layout_manager;

    this._overviewControls.add_child(this._vertAppDisplay);

    // Steal the layout of the original app display
    this._overviewLayoutManager._appDisplay = this._vertAppDisplay;

    this._injectionManager.overrideMethod(overviewControlsProto, '_updateAppDisplayVisibility', () => function (params = null) {
      if (!params) {
        params = this._stateAdjustment.getStateTransitionParams();
      }

      const { initialState, finalState } = params;
      const state = Math.max(initialState, finalState);

      extension._vertAppDisplay.visible =
        state > OverviewControls.ControlsState.WINDOW_PICKER &&
        !this._searchController.searchActive;
    });

    // Fade out the app display when the search becomes active
    this._injectionManager.overrideMethod(overviewControlsProto, '_onSearchChanged', originalFn => function () {
      originalFn.call(this);

      const { searchActive } = this._searchController;

      extension._vertAppDisplay.ease({
        opacity: searchActive ? 0 : 255,
        duration: OverviewControls.SIDE_CONTROLS_ANIMATION_TIME,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD
      });
    });

    // Rename the "Pin to Dash" item in the app menu
    this._injectionManager.overrideMethod(AppMenu.AppMenu.prototype, '_updateFavoriteItem', originalFn => function () {
      originalFn.call(this);

      if (this._toggleFavoriteItem.visible) {
        const text = this._appFavorites.isFavorite(this._app.id)
          ? _('Remove from Favorites')
          : _('Add to Favorites');

        this._toggleFavoriteItem.label.text = text;
      }
    });
  }

  disable() {
    this._overviewLayoutManager._appDisplay = this._overviewControls._appDisplay;

    this._overviewControls.remove_child(this._vertAppDisplay);
    this._injectionManager.clear();
    this._vertAppDisplay.destroy();

    this._settings = null;
    this._vertAppDisplay = null;
    this._injectionManager = null;
    this._overviewControls = null;
    this._overviewLayoutManager = null;
  }
}
