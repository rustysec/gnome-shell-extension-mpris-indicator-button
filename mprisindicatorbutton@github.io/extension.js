/*
 * Mpris Indicator Button extension for Gnome Shell 3.26+
 * Copyright 2018 Jason Gray (JasonLG1979)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * If this extension breaks your desktop you get to keep both pieces...
 */
"use strict";

const Main = imports.ui.main;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const St = imports.gi.St;
const Shell = imports.gi.Shell;

const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Panel = imports.ui.panel;

const DBusIface = `<node>
<interface name="org.freedesktop.DBus">
  <method name="ListNames">
    <arg type="as" direction="out" name="names" />
  </method>
  <signal name="NameOwnerChanged">
    <arg type="s" direction="out" name="name" />
    <arg type="s" direction="out" name="oldOwner" />
    <arg type="s" direction="out" name="newOwner" />
  </signal>
</interface>
</node>`;
const DBusProxy = Gio.DBusProxy.makeProxyWrapper(DBusIface);

const MprisIface = `<node>
<interface name="org.mpris.MediaPlayer2">
  <method name="Raise" />
  <property name="CanRaise" type="b" access="read" />
  <property name="Identity" type="s" access="read" />
  <property name="DesktopEntry" type="s" access="read" />
</interface>
</node>`;
const MprisProxy = Gio.DBusProxy.makeProxyWrapper(MprisIface);

const MprisPlayerIface = `<node>
<interface name="org.mpris.MediaPlayer2.Player">
  <method name="PlayPause" />
  <method name="Next" />
  <method name="Previous" />
  <method name="Stop" />
  <method name="Play" />
  <property name="CanGoNext" type="b" access="read" />
  <property name="CanGoPrevious" type="b" access="read" />
  <property name="CanPlay" type="b" access="read" />
  <property name="CanPause" type="b" access="read" />
  <property name="Metadata" type="a{sv}" access="read" />
  <property name="PlaybackStatus" type="s" access="read" />
</interface>
</node>`;
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

const MPRIS_PLAYER_PREFIX = "org.mpris.MediaPlayer2.";

let indicator = null;
let stockMpris = null;
let stockMprisOldShouldShow = null;

function getPlayerIconName(desktopEntry) {
    // Prefer symbolic icons.
    // The default Spotify icon name is spotify-client,
    // but the desktop entry is spotify.
    // Icon names *should* match the desktop entry...
    // Who knows if a 3rd party icon theme wil use spotify
    // or spotify-client as their spotify icon's name and
    // what they'll name their Spotify symbolic icon if
    // they have one at all?
    if (desktopEntry) {
        let possibleIconNames = [];
        if (desktopEntry.toLowerCase() === "spotify") {
            possibleIconNames = [desktopEntry + "-symbolic",
                desktopEntry + "-client-symbolic",
                desktopEntry,
                desktopEntry + "-client"
            ];
        } else {
            possibleIconNames = [desktopEntry + "-symbolic",
                desktopEntry
            ];
        }

        let currentIconTheme = Gtk.IconTheme.get_default();

        for (let i = 0; i < possibleIconNames.length; i++) {
            let iconName = possibleIconNames[i];
            if (currentIconTheme.has_icon(iconName)) {
                return iconName;
            }
        }
    }
    return "audio-x-generic-symbolic";
}

function enable() {
    stockMpris = Main.panel.statusArea.dateMenu._messageList._mediaSection;
    stockMprisOldShouldShow = stockMpris._shouldShow;
    stockMpris.actor.hide();
    stockMpris._shouldShow = function () {
        return false;
    };
    indicator = Main.panel.addToStatusArea("mprisindicatorbutton",
        new MprisIndicatorButton(), 0, "right");
}

function disable() {
    if (indicator) {
        indicator.destroy();
    }

    if (stockMpris && stockMprisOldShouldShow) {
        stockMpris._shouldShow = stockMprisOldShouldShow;
        if (stockMpris._shouldShow()) {
            stockMpris.actor.show();
        }
    }

    indicator = null;
    stockMpris = null;
    stockMprisOldShouldShow = null;
}

class Player extends PopupMenu.PopupBaseMenuItem {
    constructor(busName) {
        super();
        this._app = null;
        this._cancellable = null;
        this._playerProxy = null;
        this._mprisProxy = null;
        this._status = null;
        this._themeContext = null;
        this._signals = [];
        this._lastActiveTime = Date.now();
        this._desktopEntry = "";
        this._playerName = "";
        this._playerIconName = "audio-x-generic-symbolic";
        this._busName = busName;

        let vbox = new St.BoxLayout({
            vertical: true,
            x_expand: true
        });

        this.actor.add(vbox);

        let hbox = new St.BoxLayout();

        vbox.add(hbox);

        this._coverIcon = new St.Icon({
            style_class: "media-message-cover-icon"
        });

        hbox.add(this._coverIcon);

        let info = new St.BoxLayout({
            style_class: "message-content",
            vertical: true
        });

        this._trackArtist = new St.Label({
            style_class: "message-title"
        });

        this._trackTitle = new St.Label({
            style_class: "message-body"
        });

        info.add(this._trackArtist);

        info.add(this._trackTitle);

        hbox.add(info);

        let playerButtonBox = new St.BoxLayout();

        this._prevButton = new St.Button({
            style_class: "message-media-control",
            child: new St.Icon({
                icon_name: "media-skip-backward-symbolic",
                icon_size: 16
            })
        });

        playerButtonBox.add(this._prevButton);

        this._playPauseButton = new St.Button({
            style_class: "message-media-control",
            child: new St.Icon({
                icon_name: "media-playback-start-symbolic",
                icon_size: 16
            })
        });

        playerButtonBox.add(this._playPauseButton);

        this._stopButton = new St.Button({
            style_class: "message-media-control",
            child: new St.Icon({
                icon_name: "media-playback-stop-symbolic",
                icon_size: 16
            })
        });

        this._stopButton.hide();

        playerButtonBox.add(this._stopButton);

        this._nextButton = new St.Button({
            style_class: "message-media-control",
            child: new St.Icon({
                icon_name: "media-skip-forward-symbolic",
                icon_size: 16
            })
        });

        playerButtonBox.add(this._nextButton);

        vbox.add(playerButtonBox, {
            expand: true,
            x_fill: false,
            x_align: St.Align.MIDDLE
        });

        new MprisProxy(Gio.DBus.session, busName,
            "/org/mpris/MediaPlayer2",
            this._onMprisProxy.bind(this));
    }

    get lastActiveTime() {
        return this._lastActiveTime;
    }

    get statusValue() {
        if (this._status === "playing") {
            return 0;
        } else if (this._status === "paused") {
            return 1;
        } else {
            return 2;
        }
    }

    get desktopEntry() {
        return this._desktopEntry;
    }

    get busName() {
        return this._busName;
    }

    connectUpdate(callback) {
        this._pushSignal(this, this.connect("update-player-status", callback));
    }

    destroy() {
        if (this._signals) {
            this._signals.forEach(signal => signal.obj.disconnect(signal.signalId));
        }

        if (this._cancellable) {
            if (!this._cancellable.is_cancelled()) {
                this._cancellable.cancel();
            }
            this._cancellable.run_dispose();
        }

        if (this._mprisProxy) {
            this._mprisProxy.run_dispose();
        }

        if (this._playerProxy) {
            this._playerProxy.run_dispose();
        }

        this._app = null;
        this._cancellable = null;
        this._playerProxy = null;
        this._mprisProxy = null;
        this._status = null;
        this._themeContext = null;
        this._signals = null;
        this._lastActiveTime = null;
        this._desktopEntry = null;
        this._playerName = null;
        this._playerIconName = null;
        this._busName = null;

        super.destroy();
    }

    _pushSignal(obj, signalId) {
        this._signals.push({
            obj: obj,
            signalId: signalId
        });
    }

    _setCoverIcon(icon, coverUrl) {
        // Asynchronously set the cover icon.
        // Much more fault tolerant than:
        //
        // let file = Gio.File.new_for_uri(coverUrl);
        // icon.gicon = new Gio.FileIcon({ file: file });
        //
        // Which silently fails on error and can lead to the wrong cover being shown.
        // On error this will fallback gracefully to this._playerIconName.
        if (this._cancellable) {
            if (!this._cancellable.is_cancelled()) {
                this._cancellable.cancel();
            }
            this._cancellable.run_dispose();
            this._cancellable = null;
        }

        if (coverUrl) {
            let file = Gio.File.new_for_uri(coverUrl);
            this._cancellable = new Gio.Cancellable();
            file.load_contents_async(this._cancellable, (source, result) => {
                try {
                    let bytes = source.load_contents_finish(result)[1];
                    let newIcon = Gio.BytesIcon.new(bytes);
                    if (!newIcon.equal(icon.gicon)) {
                        icon.gicon = newIcon;
                    }
                } catch (err) {
                    if (!err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        icon.icon_name = this._playerIconName;
                    }
                }
            });
        } else {
            icon.icon_name = this._playerIconName;
        }
    }

    _updateMetadata(playerProxy) {
        let artist = "";
        let title = "";
        let coverUrl = "";
        let metadata = playerProxy.Metadata || {};
        let metadataKeys = Object.keys(metadata);

        if (this.statusValue < 2) {
            if (metadataKeys.includes("rhythmbox:streamTitle")) {
                artist = metadata["rhythmbox:streamTitle"].unpack();
            } else if (metadataKeys.includes("xesam:artist")) {
                artist = metadata["xesam:artist"].deep_unpack().join(", ");
            }

            if (metadataKeys.includes("xesam:title")) {
                title = metadata["xesam:title"].unpack();
            }

            if (metadataKeys.includes("mpris:artUrl")) {
                coverUrl = metadata["mpris:artUrl"].unpack();
            }
        }

        this._setCoverIcon(this._coverIcon, coverUrl);
        this._trackArtist.text = artist || this._playerName;
        this._trackTitle.text = title;
    }

    _updateProps(playerProxy) {
        let playPauseIconName, playPauseReactive;
        let status = playerProxy.PlaybackStatus.toLowerCase();
        let isPlaying = status === "playing";

        if (playerProxy.CanPause && playerProxy.CanPlay) {
            this._stopButton.hide();
            playPauseIconName = isPlaying ? "media-playback-pause-symbolic" : "media-playback-start-symbolic";
            playPauseReactive = true;
        } else {
            if (playerProxy.CanPlay) {
                this._stopButton.show();
            }
            playPauseIconName = "media-playback-start-symbolic";
            playPauseReactive = playerProxy.CanPlay;
        }

        this._prevButton.reactive = playerProxy.CanGoPrevious;

        this._playPauseButton.child.icon_name = playPauseIconName;

        this._playPauseButton.reactive = playPauseReactive;

        this._nextButton.reactive = playerProxy.CanGoNext;

        if (this._status !== status) {
            this._status = status;
            this._lastActiveTime = Date.now();
            this.emit("update-player-status");
        }
    }

    _onMprisProxy(mprisProxy) {
        this._mprisProxy = mprisProxy;
        this._playerName = this._mprisProxy.Identity || "";
        this._desktopEntry = this._mprisProxy.DesktopEntry || "";
        let desktopId = this._desktopEntry + ".desktop";
        this._app = Shell.AppSystem.get_default().lookup_app(desktopId);

        if (this._app || this._mprisProxy.CanRaise) {
            this._pushSignal(this, this.connect("activate", () => {
                if (this._app) {
                    this._app.activate();
                } else if (this._mprisProxy.CanRaise) {
                    this._mprisProxy.RaiseRemote();
                }
            }));
        }

        new MprisPlayerProxy(Gio.DBus.session, this._busName,
            "/org/mpris/MediaPlayer2",
            this._onPlayerProxyReady.bind(this));
    }

    _onPlayerProxyReady(playerProxy) {
        this._playerProxy = playerProxy;

        this._pushSignal(this._prevButton, this._prevButton.connect("clicked", () => {
            this._playerProxy.PreviousRemote();
        }));

        this._pushSignal(this._playPauseButton, this._playPauseButton.connect("clicked", () => {
            if (this._playerProxy.CanPause && this._playerProxy.CanPlay) {
                this._playerProxy.PlayPauseRemote();
            } else if (this._playerProxy.CanPlay) {
                this._playerProxy.PlayRemote();
            }
        }));

        this._pushSignal(this._stopButton, this._stopButton.connect("clicked", () => {
            this._playerProxy.StopRemote();
        }));

        this._pushSignal(this._nextButton, this._nextButton.connect("clicked", () => {
            this._playerProxy.NextRemote();
        }));

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);

        this._pushSignal(this._themeContext, this._themeContext.connect("changed", () => {
            this._playerIconName = getPlayerIconName(this._desktopEntry);
            this._updateMetadata(this._playerProxy);
        }));

        this._playerIconName = getPlayerIconName(this._desktopEntry);
        this._updateProps(this._playerProxy);
        this._updateMetadata(this._playerProxy);

        this._playerProxy.connect("g-properties-changed", (proxy, props, invalidated_props) => {
            props = Object.keys(props.deep_unpack()).concat(invalidated_props);
            if (props.includes("PlaybackStatus") || props.some(prop => prop.startsWith("Can"))) {
                this._updateProps(proxy);
            }

            if (props.includes("Metadata")) {
                this._updateMetadata(proxy);
            }
        });
    }
}

class MprisIndicatorButton extends PanelMenu.Button {
    constructor() {
        super(0.0, "Mpris Indicator Button", false);
        this._proxy = null;
        this._themeContext = null;
        this._signals = [];
        this._checkForPreExistingPlayers = false;

        this.actor.hide();

        this.menu.actor.add_style_class_name("aggregate-menu");

        // menuLayout keeps the Indicator the same size as the
        // system menu (aggregate menu) and makes sure our text
        // ellipses correctly.
        let menuLayout = new Panel.AggregateLayout();

        this.menu.box.set_layout_manager(menuLayout);

        // It doesn't matter what this widget is.

        menuLayout.addSizeChild(new St.Widget());

        this._indicator_icon = new St.Icon({
            style_class: "system-status-icon"
        });

        this.actor.add_child(this._indicator_icon);

        this._themeContext = St.ThemeContext.get_for_stage(global.stage);

        this._pushSignal(this._themeContext, this._themeContext.connect("changed", () => {
            this._indicator_icon.icon_name = this._getLastActivePlayerIcon();
        }));

        new DBusProxy(Gio.DBus.session,
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            this._onProxyReady.bind(this));
    }

    destroy() {
        if (this._signals) {
            this._signals.forEach(signal => signal.obj.disconnect(signal.signalId));
        }

        if (this._proxy) {
            this._proxy.run_dispose();
        }

        this._proxy = null;
        this._themeContext = null;
        this._signals = null;
        this._checkForPreExistingPlayers = null;

        super.destroy();
    }

    _pushSignal(obj, signalId) {
        this._signals.push({
            obj: obj,
            signalId: signalId
        });
    }

    _addPlayer(busName) {
        let player = new Player(busName);

        player.connectUpdate(this._updateActivePlayer.bind(this));

        this.menu.addMenuItem(player);
    }

    _updateActivePlayer() {
        this._indicator_icon.icon_name = this._getLastActivePlayerIcon();
        this.actor.show();
    }

    _removePlayer(busName) {
        let children = this.menu._getMenuItems();

        for (let i = 0; i < children.length; i++) {
            let player = children[i];
            if (busName === player.busName) {
                player.destroy();
                break;
            }
        }

        if (this.menu.isEmpty()) {
            this.actor.hide();
            this._indicator_icon.icon_name = null;
        } else {
            this._indicator_icon.icon_name = this._getLastActivePlayerIcon();
        }
    }

    _byStatusAndTime(a, b) {
        if (a.statusValue < b.statusValue) {
            return -1;
        } else if (a.statusValue > b.statusValue) {
            return 1;
        } else {
            if (a.lastActiveTime > b.lastActiveTime) {
                return -1;
            } else if (a.lastActiveTime < b.lastActiveTime) {
                return 1;
            } else {
                return 0;
            }
        }
    }

    _averageLastActiveTimeDelta(players) {
        let values = players.map(player => player.lastActiveTime);
        let len = values.length;
        let avg = values.reduce((sum, value) => sum + value) / len;
        let deltas = values.map(value => Math.abs(value - avg));
        let avgDelta = deltas.reduce((sum, value) => sum + value) / len;
        return avgDelta;
    }

    _getLastActivePlayerIcon() {
        // During the course of normal operation
        // the active player is defined by the player
        // with the highest priority status (Playing, Paused or Stopped).
        // In the case that multiple players have the same status they will
        // be sub sorted by their lastActiveTime time stamp.
        // A lone single player will of course always be the active player.
        // Things get a little more complicated when/if the extension is
        // enabled with pre existing players present. At that point
        // their lastActiveTimes are invalid for the purpose of sub sorting
        // and in the case of a status "tie" we use the generic audio icon.
        // _averageLastActiveTimeDelta is used to determine when to return to
        // normal behavior. The theory is that pre existing players will have
        // a much, much smaller average time stamp delta initially and then
        // it will become larger once the player is actually interacted with.
        let iconName = "audio-x-generic-symbolic";
        if (!this.menu.isEmpty()) {
            let players = this.menu._getMenuItems();
            if (players.length === 1) {
                iconName = getPlayerIconName(players[0].desktopEntry);
            } else if (this._checkForPreExistingPlayers) {
                if (this._averageLastActiveTimeDelta(players) < 250) {
                    let playing = players.filter(player => player.statusValue === 0);
                    if (playing.length === 1) {
                        iconName = getPlayerIconName(playing[0].desktopEntry);
                    } else if (playing.length === 0) {
                        let paused = players.filter(player => player.statusValue === 1);
                        if (paused.length === 1) {
                            iconName = getPlayerIconName(paused[0].desktopEntry);
                        }
                    }
                } else {
                    this._checkForPreExistingPlayers = false;
                    players.sort(this._byStatusAndTime);
                    iconName = getPlayerIconName(players[0].desktopEntry);
                }
            } else {
                players.sort(this._byStatusAndTime);
                iconName = getPlayerIconName(players[0].desktopEntry);
            }
        }
        return iconName;
    }

    _changePlayerOwner(busName) {
        let children = this.menu._getMenuItems();

        for (let i = 0; i < children.length; i++) {
            let player = children[i];
            if (busName === player.busName) {
                player.destroy();
                break;
            }
        }
        this._addPlayer(busName);
    }

    _onNameOwnerChanged(proxy, sender, [busName, oldOwner, newOwner]) {
        if (!busName.startsWith(MPRIS_PLAYER_PREFIX)) {
            return;
        } else if (newOwner && !oldOwner) {
            this._addPlayer(busName);
        } else if (oldOwner && !newOwner) {
            this._removePlayer(busName);
        } else if (oldOwner && newOwner) {
            this._changePlayerOwner(busName);
        }
    }

    _onProxyReady(proxy) {
        this._proxy = proxy;
        this._proxy.ListNamesRemote(([busNames]) => {
            busNames = busNames.filter(name => name.startsWith(MPRIS_PLAYER_PREFIX));
            if (busNames.length > 0) {
                busNames.sort();
                this._checkForPreExistingPlayers = true;
                busNames.forEach(busName => this._addPlayer(busName));
            }
        });

        this._proxy.connectSignal("NameOwnerChanged", this._onNameOwnerChanged.bind(this));
    }
}
