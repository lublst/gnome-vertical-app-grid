import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

const COLUMNS = 8;

export const VerticalAppDisplay = GObject.registerClass(
class VerticalAppDisplay extends St.Widget {
  _init() {
    super._init({
      layout_manager: new Clutter.BinLayout(),
      x_expand: true,
      y_expand: true
    });

    this._scrollView = new St.ScrollView({
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.NEVER
    });

    this.add_child(this._scrollView);

    const fadeEffect = new St.ScrollViewFade({
      extend_fade_area: true
    });

    this._scrollView.add_effect(fadeEffect);

    this._gridBox = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER
    });

    this._scrollView.set_child(this._gridBox);

    // Reset scroll when the overview is hidden
    Main.overview.connectObject('hidden', () => {
      this._scrollView.vadjustment.set_value(0);
    }, this);

    // Redisplay the app grid when an app was installed or removed
    Shell.AppSystem.get_default().connectObject('installed-changed', () => {
      this._redisplay();
    }, this);

    // Redisplay when parental controls change
    this._parentalControls = ParentalControlsManager.getDefault();

    this._parentalControls.connectObject('app-filter-changed', () => {
      this._redisplay();
    }, this);

    this._addAppIcons();
  }

  _addAppIcons() {
    const appSys = Shell.AppSystem.get_default();
    const appIds = this._loadApps();

    this._appIcons = appIds.map(appId => {
      return new AppDisplay.AppIcon(appSys.lookup_app(appId), { isDraggable: false });
    });

    // Arange app icons in a grid
    for (let i = 0; i < this._appIcons.length; i += COLUMNS) {
      const rowBox = new St.BoxLayout();

      this._gridBox.add_child(rowBox);

      for (let j = i; j < i + COLUMNS && j < this._appIcons.length; j++) {
        rowBox.add_child(this._appIcons[j]);
      }
    }

    this._gridBox.queue_relayout();
  }

  _loadApps() {
    const appSys = Shell.AppSystem.get_default();
    const installedApps = appSys.get_installed();

    // Filter out broken desktop files and hidden apps
    const apps = installedApps.filter(appInfo => {
      try {
        return !!appInfo.get_id() && this._parentalControls.shouldShowApp(appInfo);
      } catch {
        return false;
      }
    });

    // Sort alphabetically
    apps.sort((a, b) => a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase()));

    return apps.map(appInfo => appInfo.get_id());
  }

  _redisplay() {
    this._gridBox.destroy_all_children();
    this._addAppIcons();
  }

  destroy() {
    for (const appIcon of this._appIcons) {
      appIcon.destroy();
    }

    super.destroy();
  }
});
