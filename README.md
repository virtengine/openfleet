# OpenFleet Site

Static landing page and documentation for OpenFleet — the autonomous AI fleet supervisor.

## Local Development

```bash
cd scripts/openfleet/site
npx http-server -p 8080 -c-1
# Open http://localhost:8080
```

## Structure

```
site/
├── index.html              # Landing page
├── css/
│   ├── main.css            # Landing page styles
│   └── docs.css            # Documentation styles
├── js/
│   ├── terminal-sim.js     # jQuery Terminal integration
│   └── main.js             # Landing page JS
├── docs/
│   ├── index.html          # Docs overview
│   ├── getting-started.html # Quick start guide
│   ├── configuration.html  # Configuration reference
│   ├── cli-reference.html  # CLI flags and commands
│   ├── architecture.html   # System architecture
│   └── integrations.html   # External integrations
└── .nojekyll               # Disable Jekyll for GH Pages
```

## Deployment

The site is designed for GitHub Pages. Deploy by pushing the `site/` directory
to a `gh-pages` branch, or configure GitHub Pages to serve from a subfolder.

## Dependencies

All loaded via CDN (no build step):

- [jQuery 3.7.1](https://jquery.com/)
- [jQuery Terminal 2.42.2](https://terminal.jcubic.pl/)
- [Inter font](https://fonts.google.com/specimen/Inter)
- [JetBrains Mono font](https://fonts.google.com/specimen/JetBrains+Mono)
