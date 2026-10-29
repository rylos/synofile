The NAS's messages in languages other than Italian and English, which are
written in the code (`t!("italiano", "English")`). One `<code>.json` per
language, keyed by the Italian text, built into the binary by build.rs.

Start a language with `tools/i18n-check.py --new <code>` (it also writes the
interface's table, ui/js/lang/<code>.js) and check with `tools/i18n-check.py`.
