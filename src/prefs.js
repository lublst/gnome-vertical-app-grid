import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class EssentialTweaksPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const builder = new Gtk.Builder();

    // Load the UI file
    builder.add_from_file(`${this.path}/prefs.ui`);
    window.add(builder.get_object('preferences-page'));

    // Bind the UI to the settings
    const properties = [
      ['animate-scroll', 'active'],
      ['columns', 'value'],
      ['favorites-section', 'active'],
      ['icon-size', 'value'],
      ['icon-spacing', 'value']
    ];

    properties.forEach(([key, property]) => {
      settings.bind(key, builder.get_object(key), property, Gio.SettingsBindFlags.DEFAULT);
    });

    this._bindComboRow(builder, settings, 'app-sorting', ['usage', 'alphabetical']);
    this._bindComboRow(builder, settings, 'favorites-sorting', ['dash', 'usage', 'alphabetical']);
  }

  _bindComboRow(builder, settings, key, values) {
    const comboRow = builder.get_object(key);

    comboRow.connect('notify::selected', () => {
      settings.set_string(key, values[comboRow.selected]);
    });

    comboRow.set_selected(values.indexOf(settings.get_string(key)));
  }
}
