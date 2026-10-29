# SynoFile

A Synology DSM 7 package: a fast, dark file manager for the shared folders,
keyboard first, with tabs, a dual pane, the icons and colours of
[eza](https://github.com/eza-community/eza), and a transfer dialog that shows
what a copy is really doing: a speed chart, time left, pause, a speed limit,
conflicts file by file.

It opens from DSM's main menu like any other app, uses the DSM login, and is
reserved to the `administrators` group. Every file operation runs **as the
DSM user who asked**, so the kernel applies that user's permissions and
Synology ACLs.

![A shared folder in the list view: eza's icons and colours, folders first](docs/img/list.png)

## What it does

- **Tabs** (Ctrl+T, Ctrl+W, Ctrl+Shift+T reopens; drag to reorder, middle
  click opens a folder in a new one) and a **dual pane** (F3; F5 and F6 copy
  and move to the other pane, Tab switches).
- **List and grid**. The list looks like `eza -l` in a terminal: eza's icons
  and colours for every file type and well-known name, coloured permissions,
  sizes and dates, folders first. The grid shows Synology's own thumbnails.
  Icons, name colours and the `ll`-style columns can each be switched off.
- **Light and dark** (the sun/moon button), the light one being Tokyo Night
  Light; text size and row density.
- **Fuzzy filter** of the folder as you type (`/`), ranked, letters marked;
  **search** below it by words in the name or a glob (`*.mkv`, Ctrl+F).
- **Quick look** (Space): images, Synology thumbnails, video, audio, PDF and
  text, HEIC/HEIF photos too (decoded in the browser), arrows to the next file; an info panel with size, owner and
  permissions, folder sizes on demand.
- Copy, cut, paste and **drag and drop** (within a shared folder it moves,
  across shares it copies; Ctrl copies, Shift moves, Alt asks), rename, new
  folder, favourites, hidden files (Ctrl+H), copy a path as `/share/…`,
  `\\NAS\share\…` or `smb://`, open in File Station.
- **Upload** files and whole folders, by drop or from a dialog, in chunks
  that resume after a network error; **download** a file, or folders and
  selections as a `.zip` stream.
- **Compress** to `.zip` and **extract** zip, 7z, rar, tar, gz, bz2, xz, iso
  and more, password-protected archives included.
- **Delete into DSM's own Recycle Bin**, the way File Station does.
- Nine languages, following DSM: English, Italian, German, French, Spanish,
  Dutch, Portuguese (Portugal and Brazil), Polish.

<p align="center">
  <img src="docs/img/grid.png" alt="The grid with thumbnails, and the info panel" width="49%">
  <img src="docs/img/light.png" alt="The dual pane in the light theme" width="49%">
</p>

## Transfers

Copies, moves, deletions, archives and uploads all go through one dialog:

- a progress bar, the percentage, bytes and files done of the total, the
  phases (scan, copy, verify);
- a **speed chart**, over the progress or over time, with the average;
- current, average and peak speed, files per second, elapsed and remaining
  time, the expected end, the method (btrfs reflink, data copy, rename);
- the file in flight with its own bar;
- **conflicts** side by side, newer and bigger marked: replace, skip, keep
  both, replace if newer, apply to all;
- errors, **pause**, cancel, and a **speed limit** that can change while it
  runs.

Transfers run on the NAS: they go on when the browser closes, and the dialog,
opened again from the transfers button (Ctrl+J), shows the whole history.

<p align="center">
  <img src="docs/img/transfer.png" alt="A copy with its speed chart" width="49%">
  <img src="docs/img/conflict.png" alt="A conflict waiting for an answer" width="49%">
</p>

*The screenshots show made-up data: `tools/screenshots.sh` takes them again.*

## Install

Take `synofile-<version>.spk` from the
[releases](https://github.com/rylos/synofile/releases), or build it with
`./build.sh` (Rust with the `x86_64-unknown-linux-musl` target). Then, on the
NAS (x86_64, DSM 7):

```sh
scp -O synofile-*.spk admin@nas:
ssh admin@nas 'sudo /usr/syno/bin/synopkg install synofile-*.spk'
ssh admin@nas 'sudo /var/packages/synofile/target/bin/synofile setup'
ssh admin@nas 'sudo /usr/syno/bin/synopkg restart synofile'
```

Package Center's *Manual install* works too. **`setup` has to run again after
every install or upgrade**: the interface says so, with the command, when the
permissions are missing. `curl -s http://127.0.0.1:5000/webman/3rdparty/synofile/api.cgi/health`
on the NAS tells whether setup ran and the transfer service is up.

## How it works

DSM's web server runs `ui/api.cgi` once per request, as the package's own
unprivileged user. It execs the static `synofile` binary, which asks DSM's
`authenticate.cgi` who is logged in, refuses anyone outside
`administrators`, and then **becomes that user** before it touches a file:
groups, gid and uid, no capability left, `no_new_privs`. The kernel decides
what the user may read and change, with the Synology ACLs, as it does for
SMB.

Transfers are kept by `synofile daemon`, started with the package and
reached by the CGI over a Unix socket only the package user can open. For
each job it starts `synofile-worker` (the same program, without
capabilities, owned by root) already running as the user, and reads its
progress over a pipe. That is where the dialog's samples come from.

Becoming another user takes `CAP_SETUID` and `CAP_SETGID`. DSM 7 refuses
the `capabilities` field of `conf/privilege` in third-party packages (error
319, *invalid package privilege content*), so the package installs without
privileges and `synofile setup`, run as root, writes the file capability on
the binary. It first gives the binaries and the directories above them to
root, so the package user cannot change what root runs next time, nor the
worker that runs as the users.

Copies go through a hidden `.<name>.synofile-part` beside the target and are
renamed into place when complete: an interrupted copy never leaves half a
file under the real name. Inside one btrfs volume a copy is a **reflink**
(instant, no space used); a move inside one shared folder is a rename. An
optional verification reads every copy back and compares xxHash3. Before
a copy starts, the free space of the destination is checked.

Deleting with the Recycle Bin on hands each item to DSM's own `synorecycle`,
so it lands in `#recycle` exactly as File Station puts it there: DSM's names
for duplicates (`name_HHMMSS.ext`), the deletion time its cleanup policy
reads (`user.syno.recycle.dtime`), DSM's events. With the Recycle Bin off, or
inside it, deletion is permanent, and the interface says so first.

Archives are written by SynoFile itself (a streaming zip writer: deflate,
zip64, UTF-8 names, Unix modes); extraction uses the NAS's 7-Zip, and
`unrar` for RAR.

DSM's web server serves the interface without cache headers, so every URL
carries the build, and a page left open across an upgrade reloads itself.

## Languages

The interface follows DSM's language (`SYNO.SDS.Session.lang`, DSM codes
such as `enu`, `ita`, `ger` mapped to ISO ones), falling back to English.
Strings are written in Italian in the code: `t("Nuova cartella")` in the
interface, `t!("italiano {}", "English {}", x)` on the NAS.

- `ui/js/lang/<code>.js`: the interface, Italian text → translation.
  Plurals may give every form of the language (`{ few, many, other }`, as
  `Intl.PluralRules` names them).
- `src/lang/<code>.json`: the NAS's messages in languages other than
  Italian and English, built into the binary by `build.rs`.
- A missing or empty translation falls back to English, then to Italian.
  Dates, numbers and sorting come from `Intl` in the same language.
- `docs/glossary.md` fixes the terms, checked against DSM's own
  translations, and is shared with
  [btrbk-nas](https://github.com/rylos/btrbk-nas).

The translations were not reviewed by native speakers: corrections are
welcome.

```sh
tools/i18n-check.py --new sv   # ui/js/lang/sv.js, src/lang/sv.json, ui/texts/sve, from the English
tools/i18n-check.py            # what is missing, unused, still English or with wrong placeholders
```

Then add `description_sve="…"` to `spk/INFO.in`.

## Development

```sh
cargo build && tools/devserver.py --root /some/folder   # its subfolders play the shares
tools/screenshots.sh                                    # the README's screenshots, on made-up data
tools/gen-eza.py path/to/eza                            # regenerate eza's icons and colours
```

Debug builds honour `SYNOFILE_DEV_USER` instead of the DSM login and run
everything as whoever started them.

## Credits

The look and the keyboard come from [flea](https://github.com/thisisgm/flea).
Icons and file-type tables come from eza (MIT / EUPL-1.2), the icon font is a
subset of the [Nerd Fonts](https://www.nerdfonts.com) symbols (MIT / OFL),
and the light theme is Tokyo Night Light.

## License

MIT. `ui/vendor/libheif` is [libheif-js](https://github.com/catdad-experiments/libheif-js)
(libheif and libde265 compiled to WebAssembly), LGPL-3.0, shipped unmodified.
