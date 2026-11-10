# Flowchart app

A multi-user flowchart builder. Each person signs in and keeps their own flowcharts, and can share any chart with others by email as view-only or editable.

Each flowchart has steps with durations, branching chains that can rejoin, a start date with a projected completion window, and export to a fillable PDF.

- **Site:** https://mikes808.github.io/flowchart-app/
- **First-time setup:** see [SETUP.md](SETUP.md)

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css` | The page and its styling |
| `app.js` | Sign-in, chart list, sharing, autosave |
| `editor.js` | The flowchart editor and PDF export |
| `config.js` | Your Supabase Project URL and Publishable key |
| `supabase/schema.sql` | Database tables and access rules |
| `vendor/supabase.js` | Supabase client library (see `vendor/VERSION.txt`) |
