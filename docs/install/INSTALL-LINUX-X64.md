# Installing RaSQL: Linux on Intel or AMD (x64)

For ordinary 64-bit Linux PCs and servers. The downloads are `RaSQL-<version>-linux-amd64.deb` and
`RaSQL-<version>-linux-x86_64.AppImage`.

Check first: `uname -m` prints `x86_64`. If it prints `aarch64`, use
[INSTALL-LINUX-ARM.md](INSTALL-LINUX-ARM.md).

## Option 1: the .deb (Debian, Ubuntu, Mint, Pop!\_OS, elementary OS)

Download it from the [latest release](https://github.com/rmpel/rasql-database-manager/releases/latest)
and install it with `apt`, which also installs the libraries it needs:

```
cd ~/Downloads
sudo apt install ./RaSQL-<version>-linux-amd64.deb
```

The `./` matters: without it apt searches its repositories for a package of that name. Do not use
`sudo dpkg -i`; dpkg does not fetch dependencies and leaves the package half-installed when one is
missing. If you already did, `sudo apt install -f` finishes the job.

RaSQL appears in your applications menu and handles `rasql://`, `mysql://`, `mariadb://` and
`sqlite://` links. Start it from the menu or with `rasql`. Install a newer .deb the same way to
update.

## Option 2: the AppImage (any distribution, no root)

```
cd ~/Downloads
chmod +x RaSQL-<version>-linux-x86_64.AppImage
./RaSQL-<version>-linux-x86_64.AppImage
```

On its first launch RaSQL offers to add itself to your applications menu and register the
`rasql://` links; **File, Integrate with Desktop…** does it later. Move the AppImage to a permanent
place first (for example `~/Applications`), because the menu entry points at the file where it is.
Tools like AppImageLauncher or Gear Lever work too but are not needed.

The AppImage needs `fusermount3`, from the `fuse3` package. Ubuntu 22.04 and later, Debian 12 and
Fedora have it already; otherwise `sudo apt install fuse3`.

## Uninstall

.deb: `sudo apt remove rasql`. AppImage: delete the file, `~/.local/share/applications/rasql.desktop`
and `~/.local/share/icons/hicolor/1024x1024/apps/rasql.png`. Your connections and settings stay in
`~/.config/RaSQL`.

## Version 0.1.1 and earlier

These were packaged with an older AppImage runtime and a dependency list that did not match
Electron. Later releases and the nightly do not have these problems.

- **AppImage: "dlopen(): error loading libfuse.so.2"**: the old runtime needs FUSE 2:
  `sudo apt install libfuse2` (`libfuse2t64` on Ubuntu 24.04).
- **.deb: "rasql depends on libxss1; however: Package libxss1 is not installed"**: you installed it
  with `dpkg -i`. Run `sudo apt install -f`, which installs `libxss1` and finishes the setup. RaSQL
  does not use that library; the old package listed it anyway.

## Troubleshooting

- **"The SUID sandbox helper binary was found, but is not configured correctly"** when you start
  the AppImage from a terminal: Ubuntu 24.04 restricts the user namespaces Electron's sandbox uses
  inside an AppImage. Start it with `--no-sandbox`, or use the .deb, whose sandbox helper is
  installed properly.
- **"Warning: Ignoring XDG_SESSION_TYPE=wayland on Gnome. Use QT_QPA_PLATFORM=wayland…"**: that
  line comes from AppImageLauncher, which is a Qt program, not from RaSQL. It is harmless.
- **No keyring prompt and passwords are not in Passwords and Keys**: no Secret Service was running
  (GNOME Keyring or KDE Wallet). RaSQL then keeps passwords in its own encrypted store.
- **The LocalWP add-on shows "Get RaSQL" instead of "Open in RaSQL"**: the AppImage is not
  integrated yet. Use **File, Integrate with Desktop…**.
- **The icon does not appear in the menu**: log out and in once, or run
  `update-desktop-database ~/.local/share/applications`.
