#!/usr/bin/env python3
"""Builds ui/js/eza.js and ui/fonts/eza-icons.woff2 from eza's sources:
the same icons and file-type colours `eza --icons` prints, so a folder on
the NAS looks the way `ll` shows it in a terminal.

    tools/gen-eza.py path/to/eza [path/to/SymbolsNerdFont-Regular.ttf]

The font is cut down to the glyphs the table uses (pyftsubset, from
fonttools, with brotli for woff2).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Folder names DSM and Italian users have, mapped to eza's own glyphs.
EXTRA_DIRS = {
    "Documenti": "\U000f0c82", "Scaricati": "\U000f024d", "Download": "\U000f024d",
    "Musica": "\U000f1359", "music": "\U000f1359", "Immagini": "\U000f024f", "Foto": "\U000f024f",
    "photo": "\U000f024f", "Photos": "\U000f024f", "Video": "\U000f0fce", "video": "\U000f0fce",
    "Film": "\U000f0fce", "Serie-TV": "\U000f0fce", "Cartoni": "\U000f0fce", "Scrivania": "\uf108",
    "#recycle": "\uf1f8", "homes": "\U000f10b5", "home": "\U000f10b5", "docker": "\ue650",
    "backup": "\U000f0bc6", "web": "\U000f059f", "iso": "\ue271", "Games": "\U000f0eb5",
    "Software": "\U000f03d6", "temp": "\uf43a", "dev": "\ue5fc", "surveillance": "\U000f0567",
}

# The icons a folder can be given by hand (the picker in the info panel):
# Material Design glyph names of the Nerd Font, with the words that find
# them, Italian and English.
CHOICES = [
    ("folder", "cartella folder"), ("folder_star", "stella preferiti star favourite"),
    ("folder_heart", "cuore amore heart love"), ("folder_account", "persona utente account person user"),
    ("folder_home", "casa home"), ("folder_lock", "lucchetto privato lock private"),
    ("folder_key", "chiave password key"), ("folder_image", "immagini foto image photo"),
    ("folder_multiple_image", "album foto gallery photos"), ("folder_music", "musica music"),
    ("folder_play", "video film movie play"), ("folder_text", "testo note text notes"),
    ("folder_file", "documenti file documents"), ("folder_table", "tabelle excel table sheet"),
    ("folder_zip", "archivio zip archive"), ("folder_download", "scaricati download"),
    ("folder_upload", "caricati upload"), ("folder_sync", "sincronizzati sync"),
    ("folder_network", "rete condivisa network share"), ("folder_google_drive", "drive cloud google"),
    ("folder_cog", "impostazioni settings config"), ("folder_wrench", "strumenti attrezzi tools"),
    ("folder_clock", "storico vecchio history old"), ("folder_check", "fatto completato done check"),
    ("folder_alert", "importante attenzione important alert"), ("folder_question", "da vedere dubbio question"),
    ("folder_eye", "visto watch eye"), ("folder_hidden", "nascosta hidden"),
    ("folder_marker", "luogo posto place location"), ("folder_edit", "in corso bozza draft edit"),
    ("folder_information", "informazioni info"), ("folder_cancel", "scartati annullati rejected cancel"),
    ("folder_search", "ricerca search"), ("folder_swap", "scambio transfer swap"),
    ("briefcase", "lavoro ufficio work office"), ("account_group", "clienti gruppo team clients group"),
    ("account_tie", "fornitori personale suppliers staff"), ("receipt", "fatture ricevute invoices receipts"),
    ("cash", "soldi pagamenti money payments"), ("file_sign", "contratti firma contracts sign"),
    ("domain", "azienda edificio company building"), ("factory", "produzione fabbrica production factory"),
    ("home", "casa home"), ("car", "auto macchina car"), ("school", "scuola school"),
    ("hospital_box", "salute medico health medical"), ("bank", "banca bank"), ("cart", "acquisti spesa shopping"),
    ("airplane", "viaggi vacanze travel holidays"), ("gamepad_variant", "giochi games"),
    ("book_open_variant", "libri manuali books manuals"), ("camera", "fotocamera camera"),
    ("movie_open", "film cinema movies"), ("music", "musica music"), ("video", "video"),
    ("image", "immagine image"), ("file_document", "documento document"), ("file_pdf_box", "pdf"),
    ("email", "posta mail email"), ("phone", "telefono phone"), ("map_marker", "mappa luogo map place"),
    ("earth", "mondo web world"), ("usb_flash_drive", "usb chiavetta pennetta flash drive stick"),
    ("usb", "usb"), ("harddisk", "disco hard disk drive esterno external"), ("sd", "sd scheda card memoria memory"),
    ("server", "server"), ("database", "database dati data"),
    ("cloud", "cloud nuvola"), ("shield_check", "sicurezza backup security"), ("archive", "archivio archive"),
    ("calendar_month", "calendario anno calendar year"), ("star", "stella star"), ("heart", "cuore heart"),
    ("lock", "lucchetto lock"), ("printer", "stampa printer"), ("tools", "attrezzi tools"),
    ("hammer_wrench", "manutenzione maintenance"), ("wrench", "chiave inglese wrench"),
    ("ruler_square_compass", "cad disegni progetti drawings projects"), ("cube_outline", "3d modelli models"),
    ("package_variant_closed", "pacchetti software packages"), ("flask", "esperimenti test lab"),
    ("palette", "grafica design art"), ("lightbulb", "idee ideas"), ("rocket_launch", "progetti lancio projects launch"),
    ("chart_bar", "statistiche report charts"), ("code_braces", "codice sviluppo code dev"), ("git", "git"),
    ("linux", "linux"), ("microsoft_windows", "windows"), ("apple", "apple mac"), ("android", "android"),
    ("paw", "animali cane gatto pets"), ("tree", "natura giardino nature garden"), ("baby_carriage", "bambini figli kids baby"),
]


def char(literal):
    return chr(int(literal, 16))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    eza = Path(sys.argv[1])
    font = Path(sys.argv[2] if len(sys.argv) > 2 else "/usr/share/fonts/TTF/SymbolsNerdFont-Regular.ttf")
    icons_rs = (eza / "src/output/icons.rs").read_text()
    types_rs = (eza / "src/info/filetype.rs").read_text()

    consts = {m[1]: char(m[2]) for m in re.finditer(r"const (\w+):\s*char\s*=\s*'\\u\{([0-9a-fA-F]+)\}'", icons_rs)}

    def icon_map(name):
        body = re.search(rf"const {name}: Map<&'static str, char> = phf_map! \{{(.*?)\n\}};", icons_rs, re.S)[1]
        out = {}
        for m in re.finditer(r"\"([^\"]+)\"\s*=>\s*(?:Icons::(\w+)|'\\u\{([0-9a-fA-F]+)\}')", body):
            out[m[1]] = consts[m[2]] if m[2] else char(m[3])
        return out

    def type_map(name):
        body = re.search(rf"const {name}: Map<&'static str, FileType> = phf_map! \{{(.*?)\n\}};", types_rs, re.S)[1]
        return {m[1]: m[2].lower() for m in re.finditer(r"\"([^\"]+)\"\s*=>\s*FileType::(\w+)", body)}

    from fontTools.ttLib import TTFont
    by_name = {v: k for k, v in TTFont(font).getBestCmap().items()}
    choices = [[chr(by_name["md-" + n]), words] for n, words in CHOICES]

    dirs = icon_map("DIRECTORY_ICONS")
    dirs.update(EXTRA_DIRS)
    data = {
        "icons": {k.lower(): v for k, v in consts.items()},
        "dirs": dirs,
        "names": icon_map("FILENAME_ICONS"),
        "exts": icon_map("EXTENSION_ICONS"),
        "nameTypes": type_map("FILENAME_TYPES"),
        "extTypes": type_map("EXTENSION_TYPES"),
        "choices": choices,
    }
    head = ("// Generated by tools/gen-eza.py from eza's icons.rs and filetype.rs\n"
            "// (eza: MIT / EUPL-1.2). Do not edit by hand.\n")
    out = ROOT / "ui/js/eza.js"
    out.write_text(head + "export default " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")

    used = set(dirs.values()) | set(data["names"].values()) | set(data["exts"].values()) | set(consts.values()) | {g for g, _ in choices}
    unicodes = ",".join(f"U+{ord(c):X}" for c in sorted(used))
    fonts = ROOT / "ui/fonts"
    fonts.mkdir(exist_ok=True)
    subprocess.run(["pyftsubset", str(font), f"--unicodes={unicodes}", "--flavor=woff2",
                    f"--output-file={fonts / 'eza-icons.woff2'}", "--no-hinting", "--desubroutinize"], check=True)
    print(f"{out}: {len(dirs)} folders, {len(data['names'])} names, {len(data['exts'])} extensions, {len(choices)} choices; {len(used)} glyphs")


if __name__ == "__main__":
    main()
