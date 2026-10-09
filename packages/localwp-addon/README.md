# RaSQL add-on for LocalWP

Adds an **Open in RaSQL** button to every site's Database tab in Local, right before Local's own
"Open AdminNeo" button. Clicking it opens the site's database in RaSQL over the site's Unix socket
on macOS and Linux, or its TCP port on Windows.

You do not install this by hand: RaSQL ships it and offers to install or update it whenever it
finds Local on the machine. Local loads add-ons at startup, so restart Local afterwards.

Manual install, if you want it anyway: build with `pnpm --filter @rasql/localwp-addon build`,
copy `dist/` to `<Local data>/addons/rasql-localwp`, and set `"rasql-localwp": true` in
`<Local data>/enabled-addons.json`. The Local data directory is `~/Library/Application Support/Local`
on macOS, `%APPDATA%\Local` on Windows and `~/.config/Local` on Linux.

Local injects only `react`, `react-dom`, `@getflywheel/local` and `@getflywheel/local/renderer` into
add-ons. This add-on uses nothing else, which is why it ships without `node_modules`.
