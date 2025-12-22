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
    settings.bind('columns', builder.get_object('columns-row'), 'value', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('icon-size', builder.get_object('icon-size-row'), 'value', Gio.SettingsBindFlags.DEFAULT);
    settings.bind('icon-spacing', builder.get_object('icon-spacing-row'), 'value', Gio.SettingsBindFlags.DEFAULT);
  }
}
