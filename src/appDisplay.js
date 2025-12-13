import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';

const COLUMNS = 8;

export const VerticalAppDisplay = GObject.registerClass(
class VerticalAppDisplay extends St.Widget {
  _init() {
    super._init({
      layout_manager: new Clutter.BoxLayout(),
      reactive: true
    });

    this._scrollView = new St.ScrollView({
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.NEVER,
      x_expand: true,
      y_expand: true
    });
    this.add_child(this._scrollView);

    this._gridBox = new St.BoxLayout({
      orientation: Clutter.Orientation.VERTICAL,
      x_align: Clutter.ActorAlign.CENTER
    });
    this._scrollView.set_child(this._gridBox);

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
  }

  _loadApps() {
    const appSys = Shell.AppSystem.get_default();
    const installedApps = appSys.get_installed();

    // Filter out broken desktop files and hidden apps
    const apps = installedApps.filter(appInfo => {
      try {
        return !!appInfo.get_id() && !appInfo.get_nodisplay();
      } catch {
        return false;
      }
    });

    // Sort alphabetically
    apps.sort((a, b) => a.get_name().toLowerCase().localeCompare(b.get_name().toLowerCase()));

    return apps.map(appInfo => appInfo.get_id());
  }

  vfunc_destroy() {
    for (const appIcon of this._apps) {
      appIcon.destroy();
    }
  }
});
