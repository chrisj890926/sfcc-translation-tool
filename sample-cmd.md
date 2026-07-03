# Running the translator

Start the web UI (default Google provider, no key needed):

```
npm start
# -> http://localhost:3000
```

The standalone CLI (`node extract-content-xdefault.js input.xml output.xml`) was
removed in the v2 refactor; translation logic now lives under `src/`. A CLI entry
point can be re-added in a later phase if needed — see README.md.
