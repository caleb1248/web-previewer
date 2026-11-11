# Change Log

## [v0.0.3]

- Fixed name consistency issues across the project (Web Previewer v.s. JS Preview)
- Added support to install dependencies from NPM, given that a package-lock.json (or bun.lock) already exists in the project root.
- Imports starting with `/` resolve to the project's `public` directory if it exists.

## [0.0.2]

- First published release: renamed the extension ID, fixed some bugs.

## [0.0.1]

- Preview release: "Start Web Preview" command that bundles an HTML page's scripts and stylesheets with rolldown and shows it in a live-reloading webview.
