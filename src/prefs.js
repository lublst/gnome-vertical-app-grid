import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';

import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function lookupAppName(appId) {
  try {
    const appInfo = Gio.DesktopAppInfo.new(appId);
    return appInfo ? appInfo.get_name() : appId;
  } catch {
    return appId;
  }
}

export default class EssentialTweaksPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const builder = new Gtk.Builder();

    builder.add_from_file(`${this.path}/prefs.ui`);
    const page = builder.get_object('preferences-page');
    window.add(page);

    const properties = [
      ['animate-scroll', 'active'],
      ['columns', 'value'],
      ['folders-section', 'active'],
      ['icon-size', 'value'],
      ['icon-spacing', 'value']
    ];

    properties.forEach(([key, property]) => {
      settings.bind(key, builder.get_object(key), property, Gio.SettingsBindFlags.DEFAULT);
    });

    this._bindComboRow(builder, settings, 'app-sorting', ['usage', 'alphabetical', 'custom']);
    this._bindComboRow(builder, settings, 'pinned-sorting', ['usage', 'alphabetical', 'custom']);

    this._buildHiddenAppsGroup(page, settings);
    this._buildFoldersGroup(page, settings);
    this._buildLayoutGroup(page, settings);
  }

  _bindComboRow(builder, settings, key, values) {
    const comboRow = builder.get_object(key);

    comboRow.connect('notify::selected', () => {
      settings.set_string(key, values[comboRow.selected]);
    });

    comboRow.set_selected(values.indexOf(settings.get_string(key)));
  }

  _buildHiddenAppsGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _('Hidden Apps'),
      description: _('Apps hidden from the app drawer via their right-click menu')
    });

    const resetButton = new Gtk.Button({
      label: _('Reset All'),
      valign: Gtk.Align.CENTER,
      css_classes: ['destructive-action']
    });
    resetButton.connect('clicked', () => {
      settings.set_strv('hidden-apps', []);
    });
    group.set_header_suffix(resetButton);

    page.add(group);

    const rows = new Map();

    const refresh = () => {
      const hidden = settings.get_strv('hidden-apps');
      const seen = new Set(hidden);

      resetButton.visible = hidden.length > 0;

      for (const [appId, row] of rows) {
        if (!seen.has(appId)) {
          group.remove(row);
          rows.delete(appId);
        }
      }

      hidden.forEach(appId => {
        if (rows.has(appId)) {
          return;
        }

        const name = lookupAppName(appId);

        const row = new Adw.ActionRow({ title: name });

        const button = new Gtk.Button({
          label: _('Show'),
          valign: Gtk.Align.CENTER
        });

        button.connect('clicked', () => {
          const current = settings.get_strv('hidden-apps');
          settings.set_strv('hidden-apps', current.filter(id => id !== appId));
        });

        row.add_suffix(button);
        group.add(row);

        rows.set(appId, row);
      });

      group.visible = hidden.length > 0;
    };

    settings.connect('changed::hidden-apps', refresh);
    refresh();
  }

  _buildFoldersGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _('Folders'),
      description: _('Folders created via an app\u2019s right-click menu \u2192 Add to Folder, or by dragging one app onto another')
    });

    page.add(group);

    const folderSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.app-folders' });
    const getFolderSettings = id => new Gio.Settings({
      schema_id: 'org.gnome.desktop.app-folders.folder',
      path: `${folderSettings.path}folders/${id}/`
    });

    const rows = new Map();

    const refresh = () => {
      const ids = folderSettings.get_strv('folder-children');
      const seen = new Set(ids);

      for (const [id, row] of rows) {
        if (!seen.has(id)) {
          group.remove(row);
          rows.delete(id);
        }
      }

      ids.forEach(id => {
        const folder = getFolderSettings(id);
        const apps = folder.get_strv('apps');

        if (apps.length === 0 && folder.get_strv('categories').length > 0) {
          return;
        }

        const name = folder.get_string('name');
        const appNames = apps.map(appId => lookupAppName(appId)).join(', ');

        if (rows.has(id)) {
          const row = rows.get(id);
          row.title = name;
          row.subtitle = appNames;
          return;
        }

        const row = new Adw.ActionRow({
          title: name,
          subtitle: appNames
        });

        const button = new Gtk.Button({
          label: _('Delete'),
          valign: Gtk.Align.CENTER,
          css_classes: ['destructive-action']
        });

        button.connect('clicked', () => {
          folder.settings_schema.list_keys().forEach(key => folder.reset(key));

          const remaining = folderSettings.get_strv('folder-children').filter(existingId => existingId !== id);
          folderSettings.set_strv('folder-children', remaining);
        });

        row.add_suffix(button);
        group.add(row);

        rows.set(id, row);
      });

      group.visible = rows.size > 0;
    };

    folderSettings.connect('changed::folder-children', refresh);
    refresh();
  }

  _buildLayoutGroup(page, settings) {
    const group = new Adw.PreferencesGroup({
      title: _('Layout')
    });

    const appOrderRow = new Adw.ActionRow({
      title: _('Reset Custom Order'),
      subtitle: _('The app drawer order set by dragging icons around, used when App Sorting is set to Custom')
    });

    const appOrderButton = new Gtk.Button({
      label: _('Reset'),
      valign: Gtk.Align.CENTER,
      css_classes: ['destructive-action']
    });

    appOrderButton.connect('clicked', () => {
      settings.set_string('custom-order', '[]');
    });

    appOrderRow.add_suffix(appOrderButton);
    group.add(appOrderRow);

    const pinnedOrderRow = new Adw.ActionRow({
      title: _('Reset Pinned Order'),
      subtitle: _('The pinned order set by dragging icons around, used when Pinned Sorting is set to Manual')
    });

    const pinnedOrderButton = new Gtk.Button({
      label: _('Reset'),
      valign: Gtk.Align.CENTER,
      css_classes: ['destructive-action']
    });

    pinnedOrderButton.connect('clicked', () => {
      settings.set_string('pinned-order', '[]');
    });

    pinnedOrderRow.add_suffix(pinnedOrderButton);
    group.add(pinnedOrderRow);

    const folderOrderRow = new Adw.ActionRow({
      title: _('Reset Folders Order'),
      subtitle: _('The folder order set by dragging folders around in the Folders section')
    });

    const folderOrderButton = new Gtk.Button({
      label: _('Reset'),
      valign: Gtk.Align.CENTER,
      css_classes: ['destructive-action']
    });

    folderOrderButton.connect('clicked', () => {
      settings.set_string('folders-order', '[]');
    });

    folderOrderRow.add_suffix(folderOrderButton);
    group.add(folderOrderRow);

    page.add(group);
  }
}
