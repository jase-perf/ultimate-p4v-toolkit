# Ultimate P4V Toolkit

A collection of custom tools for P4V and P4Admin, built as HTML tools and served from GitHub Pages. Import the XML definitions into P4V yourself, or publish them from your P4 Server so your whole team gets them with nothing to install.

Work in progress.

## Tools

| Tool | Type | Argument | Who can use it |
|---|---|---|---|
| [Reset User Password](site/tools/reset-password/) | HTML Window | `%u` (user) | Super users |
| [Revert Exclusive Checkouts](site/tools/revert-exclusive-checkouts/) | HTML Window | `%D` or `%F` (all selected files) | Admins and super users |
| [Typemap Editor](site/tools/typemap/) | HTML Tab | none | Admins and super users |
| [AI Help](site/tools/ai-help/) | HTML Tab | none | Everyone |

Tools that need elevated access check the current user's access level when they open. Users without it get a clear explanation instead of a raw permission error.

## License

MIT. See [LICENSE](LICENSE).
