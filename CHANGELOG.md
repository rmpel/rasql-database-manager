= 0.2.0 = 2026-10-20

- MCP server: AI agents such as Claude Code reach the connections you open up for them. Every connection has an MCP setting (Hidden, Read-only, Ask, Secure, Read/Write) in its form; Hidden is the default. Secure has the operating system confirm you for every change (Touch ID or password on macOS, Windows Hello or password on Windows, polkit on Linux), so no other program can approve one with a click. MCP is tested on macOS only; Windows and Linux testers are wanted, see [README.md](README.md). Changes wait for your answer in a prompt with Once, This session, Always, Deny and Review; changes that can lose data always ask. Set it up under File › MCP Server, see [MCP.md](MCP.md).
- LocalWP sites get their MCP setting from a ⚙ next to each site, with one default for all Local sites in the MCP window.
- Bugfix: MySQL: a statement could fail with "Query cancelled" when it ran right after a read that stopped at its row limit.

= 0.1.2 = 2026-10-13

- Bugfix: The Linux ARM64 AppImage did not start ("libz.so: cannot open shared object file"). AppImages now use the static runtime, which needs no libfuse2 or zlib, only fuse3.
- Bugfix: The Linux .deb no longer depends on libxss1 and libxtst6, which RaSQL does not use, and now lists libgbm1 and libasound2, which it does.
- Installation guides for the pre-built packages per OS and CPU, see [INSTALL.md](INSTALL.md). On Linux, install the .deb with `sudo apt install ./<file>.deb`.

= 0.1.1 = 2026-10-12

- Bugfix: Text selection in Query Editor fixed.

= 0.1.0 = 2026-10-10

- Initial release, see [README.md](README.md) and [LICENSE](LICENSE) for Licencing details
- See [docs/](docs/) for additional documentation
- See [CONTRIBUTING.md](CONTRIBUTING.md) on how you can help build this app
- For build instructions, see [BUILD.md](BUILD.md)
