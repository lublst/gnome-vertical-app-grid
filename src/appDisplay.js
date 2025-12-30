import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';

export const VerticalAppDisplay = GObject.registerClass(
class VerticalAppDisplay extends St.Widget {
  _init(settings) {
    this._settings = settings;

    super._init({
      layout_manager: new Clutter.BinLayout()
    });

    this._scrollView = new St.ScrollView({
      hscrollbar_policy: St.PolicyType.NEVER,
      vscrollbar_policy: St.PolicyType.NEVER,
      x_expand: true,
      y_expand: true
    });

    this.add_child(this._scrollView);

    // Fade out the edges of the scroll view
    const fadeEffect = new St.ScrollViewFade({
      extend_fade_area: true
    });

    this._scrollView.add_effect(fadeEffect);

    const scrollBox = new St.BoxLayout({
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: false,
      y_expand: false,
      vertical: true
    });

    this._scrollView.set_child(scrollBox);

    // Favorites section
    this._favoritesLabel = new St.Label({
      style_class: 'search-statustext',
      text: 'Favorites'
    });

    this._favoritesLayout = new VerticalAppDisplayLayout(
      this._settings.get_int('columns'),
      this._settings.get_int('icon-spacing')
    );

    this._favoritesView = new St.Viewport({
      layout_manager: this._favoritesLayout
    });

    // Main section
    this._mainLabel = new St.Label({
      style_class: 'search-statustext',
      text: 'All Apps'
    });

    this._mainLayout = new VerticalAppDisplayLayout(
      this._settings.get_int('columns'),
      this._settings.get_int('icon-spacing')
    );

    this._mainView = new St.Viewport({
      layout_manager: this._mainLayout
    });

    scrollBox.add_child(this._favoritesLabel);
    scrollBox.add_child(this._favoritesView);
    scrollBox.add_child(this._mainLabel);
    scrollBox.add_child(this._mainView);

    this._appSystem = Shell.AppSystem.get_default();
    this._appFavorites = AppFavorites.getAppFavorites();
    this._parentalControls = ParentalControlsManager.getDefault();

    this._connectSignals();
    this._addAppIcons();
  }

  _connectSignals() {
    // Redisplay when the favorites section is toggled
    this._settings.connectObject('changed::favorites-section', () => {
      this._redisplay();
    }, this);

    // Redisplay the app grid when an app was installed or removed
    this._appSystem.connectObject('installed-changed', () => {
      this._redisplay();
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
    Main.overview.connectObject('hidden', () => {
      this._scrollView.vadjustment.set_value(0);
    }, this);

    // Update layout when settings change
    this._settings.connectObject('changed::columns', () => {
      const columns = this._settings.get_int('columns');

      this._favoritesLayout.columns = columns;
      this._mainLayout.columns = columns;
    }, this);

    this._settings.connectObject('changed::icon-spacing', () => {
      const spacing = this._settings.get_int('icon-spacing');

      this._favoritesLayout.spacing = spacing;
      this._mainLayout.spacing = spacing;
    }, this);

    this._settings.connectObject('changed::icon-size', () => {
      const size = this._settings.get_int('icon-size');

      this._appIcons.forEach(appIcon => {
        appIcon.icon.setIconSize(size);
      });
    }, this);
  }

  _addAppIcons() {
    const iconSize = this._settings.get_int('icon-size');
    const favSection = this._settings.get_boolean('favorites-section');

    this._appIcons = this._loadApps()
      .map(id => this._appSystem.lookup_app(id))
      .map(app => new AppDisplay.AppIcon(app, { isDraggable: false }));

    this._appIcons.forEach(appIcon => {
      appIcon.icon.setIconSize(iconSize);

      if (favSection && this._appFavorites.isFavorite(appIcon._id)) {
        this._favoritesView.add_child(appIcon);
      } else {
        this._mainView.add_child(appIcon);
      }
    });

    const showFavSection = this._favoritesView.get_children().length > 0;
    const showMainSection = this._mainView.get_children().length > 0;
    const showMainLabel = showFavSection && showMainSection;

    this._favoritesLabel.visible = showFavSection;
    this._favoritesView.visible = showFavSection;
    this._mainLabel.visible = showMainLabel;
    this._mainView.visible = showMainSection;
  }

  _loadApps() {
    const installedApps = this._appSystem.get_installed();

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
    this._favoritesView.destroy_all_children();
    this._mainView.destroy_all_children();
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
