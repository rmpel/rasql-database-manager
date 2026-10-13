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
