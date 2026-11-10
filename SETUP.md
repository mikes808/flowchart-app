# Setup

The app is a static site on GitHub Pages. Sign-in and storage come from a free Supabase project. Setup takes about 15 minutes and you only do it once.

Your site address will be: **https://mikes808.github.io/flowchart-app/**

## 1. Turn on GitHub Pages

In this repository: **Settings → Pages**. Set **Source** to "Deploy from a branch", choose `main` and `/ (root)`, and save. Until step 4 is done the site shows a "connect the database" page.

## 2. Create a Supabase project

1. Sign up at https://supabase.com and click **New project**.
2. Pick any name and region, and set a database password (save it somewhere; the app never needs it).
3. Wait a minute or two for the project to finish setting up.

## 3. Create the tables

1. In the Supabase dashboard, open **SQL Editor** and start a new query.
2. Open `supabase/schema.sql` from this repository, copy all of it, paste it in, and click **Run**.

It should finish with "Success. No rows returned". Running it again later is safe and does not delete charts.

## 4. Connect the app to the project

1. In Supabase, open **Project Settings → API Keys** and copy the **Publishable key** (it starts with `sb_publishable_`). On an older project, the **anon public** key under "Legacy API Keys" works too.
2. Copy the **Project URL** (it looks like `https://abcdefghijkl.supabase.co`). It is under **Project Settings → Data API**, and also in the **Connect** dialog at the top of the dashboard.
3. In this repository, open `config.js`, click the pencil icon, paste the two values between the quotes, and commit.

Both values are meant to be public. The database's access rules decide who can read or change each chart. **Never** paste a key labelled "secret" or "service_role" into this repository.

## 5. Tell Supabase where the site lives

In Supabase, open **Authentication → URL Configuration**:

- **Site URL:** `https://mikes808.github.io/flowchart-app/`
- **Redirect URLs:** add `https://mikes808.github.io/flowchart-app/**`

Without this, the links in confirmation and password-reset emails go to the wrong place.

## 6. Try it

Open the site, click **Create an account**, confirm your email from the link Supabase sends, and sign in.

## Things to know

- **Keep email confirmation on.** Sharing is by email address, so it relies on people proving they own their address. It is on by default (Authentication → Sign In / Providers → Email → "Confirm email").
- **Sign-up emails are limited.** Supabase's built-in email sender only sends a couple of emails per hour, which is fine for testing. Before inviting a group, add your own email service under Authentication → SMTP (Resend, SendGrid and Postmark all have free tiers).
- **Free projects can be paused.** Supabase may pause a free project that has had little activity for about a week. Charts are kept; you restore the project from the Supabase dashboard.
- **Anyone with the site address can create an account**, but they only see their own charts and ones shared with them. To restrict who can sign up, turn off "Allow new users to sign up" in the Email provider settings and invite people from Authentication → Users.

## How sharing works

The owner of a chart clicks **Share** and adds an email address as "Can view" or "Can edit". No email is sent. When that person signs in with that address, the chart appears under "Shared with me". Only the owner can share or delete a chart.

If two people edit the same chart at once, the second save is stopped and that person chooses between loading the latest version and overwriting it. Edits do not appear live in the other person's window.
