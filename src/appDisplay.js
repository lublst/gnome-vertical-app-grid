import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

export const VerticalAppDisplay = GObject.registerClass(
class VerticalAppDisplay extends St.Widget {
  _init(settings) {
    this._settings = settings;

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

    this._gridLayout = new VerticalAppDisplayLayout(
      this._settings.get_int('columns'),
      this._settings.get_int('icon-spacing')
    );

    this._gridView = new St.Viewport({
      layout_manager: this._gridLayout,
      y_expand: true
    });

    this._scrollView.set_child(this._gridView);

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

    // Update layout when settings change
    this._settings.connectObject('changed::columns', () => {
      this._gridLayout.columns = this._settings.get_int('columns');
    }, this);

    this._settings.connectObject('changed::icon-spacing', () => {
      this._gridLayout.spacing = this._settings.get_int('icon-spacing');
    }, this);

    this._settings.connectObject('changed::icon-size', () => {
      const size = this._settings.get_int('icon-size');

      this._appIcons.forEach(appIcon => {
        appIcon.icon.setIconSize(size);
      });
    }, this);

    this._addAppIcons();
  }

  _addAppIcons() {
    const iconSize = this._settings.get_int('icon-size');
    const appSys = Shell.AppSystem.get_default();
    const appIds = this._loadApps();

    this._appIcons = appIds.map(appId => {
      const appIcon = new AppDisplay.AppIcon(appSys.lookup_app(appId), {
        isDraggable: false
      });

      appIcon.icon.setIconSize(iconSize);

      return appIcon;
    });

    this._appIcons.forEach(icon => {
      this._gridView.add_child(icon);
    });
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
    apps.sort((a, b) => {
      const aName = a.get_name().toLowerCase();
      const bName = b.get_name().toLowerCase();

      return aName.localeCompare(bName);
    });

    return apps.map(appInfo => appInfo.get_id());
  }

  _redisplay() {
    this._gridView.destroy_all_children();
    this._addAppIcons();
  }

  destroy() {
    for (const appIcon of this._appIcons) {
      appIcon.destroy();
    }

    super.destroy();
  }
});

const VerticalAppDisplayLayout = GObject.registerClass(
class VerticalAppDisplayLayout extends Clutter.LayoutManager {
  _init(columns, spacing) {
    super._init();

    this._columns = columns;
    this._spacing = spacing;
  }

  vfunc_get_preferred_width(container, _forHeight) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);

    const size = this._columns * childSize + (this._columns - 1) * this._spacing;

    return [size, size];
  }

  vfunc_get_preferred_height(container, _forWidth) {
    const children = container.get_children();
    const childSize = this._getMinChildSize(children);

    const rows = Math.ceil(children.length / this._columns);
    const size = rows * childSize + (rows - 1) * this._spacing;

    return [size, size];
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

  set columns(columns) {
    this._columns = columns;
  }

  set spacing(spacing) {
    this._spacing = spacing;
  }
});
