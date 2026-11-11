# Ultimate P4V Toolkit

A collection of custom tools for P4V and P4Admin. Most are HTML tools served from GitHub Pages. A few are command-line Custom Tools that run a short inline script, for things the P4V JavaScript API can't do. Import the definitions into P4V yourself, or publish them from your P4 Server so your whole team gets them with nothing to install.

Work in progress.

**Tool URLs and setup details:** <https://jase.town/ultimate-p4v-toolkit/>. The site is published from the `site/` folder by GitHub Actions on every push to `main`.

## Tools

| Tool | Type | Argument | Who can use it |
|---|---|---|---|
| [Project Activity](site/tools/project-activity/) | HTML Tab (or HTML Window) | none (`%D` as a window) | Everyone |
| [Depot Size Map](site/tools/depot-size-map/) | HTML Tab (or HTML Window) | none (`%D` as a window) | Everyone |
| [Server Activity](site/tools/server-activity/) | HTML Tab | none | Everyone |
| [Reset User Password](cli-tools/reset-password/) | Custom Tool (Windows / macOS, needs `p4` on PATH) | `%u` (user) | Super users |
| [Revert Exclusive Checkouts](site/tools/revert-exclusive-checkouts/) | HTML Window | `%D`, `%F`, or `%r` (files or folders) | Admins and super users |
| [Typemap Editor](site/tools/typemap/) | HTML Tab | none | Admins and super users |
| [AI Help](site/tools/ai-help/) | HTML Tab | none | Everyone |

Tools that need elevated access check the current user's access level when they open. Users without it get a clear explanation instead of a raw permission error.

## License

MIT. See [LICENSE](LICENSE).

Includes [D3](https://d3js.org) 7.9.0 (ISC license, see [`site/shared/vendor/d3-LICENSE.txt`](site/shared/vendor/d3-LICENSE.txt)).
