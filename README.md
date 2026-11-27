# Eternawell-New

Site designs for EternaWell Medicine. Netlify publishes the `site/` folder (see the hosting notes below).

| URL | Version |
|---|---|
| `/` | Version picker |
| `/v6/` | Editorial multi-page site with photography placeholders |
| `/v7/` | v6 in a bright warm palette with AA contrast, stock photos and fill-in provider bios |
| `/v8/` | EternaWell Medicine: the doctor's requirements (four services, booking slot, Bellevue details, privacy policies), brighter palette, latest |

Other folders:
- `src/v6/` to `src/v8/` + `tools/build.sh` — v6 to v8 are generated from shared templates. Edit pages or the clinic details at the top of the script, then run `bash tools/build.sh v8`. v8 keeps its build-time clinic details in `src/v8/config.sh`, and its Chinese pages in `src/v8/zh/` (built to `/v8/zh/`; each page links to its counterpart in the other language); the build also runs `tools/editable.py`, which marks text and photos for the admin editor
- Photos: each placeholder is a `<figure class="ph">` in `src/v8/pages/`. Put an `<img src="..." alt="...">` inside it and the placeholder styling hides itself. Images marked `data-stock` are free Unsplash stand-ins to swap for real photography; the Services hover previews come from each row's `data-img`
- Fill-in blanks in v8 (doctor's bio, screening tests, legal text): replace each highlighted `<span class="todo">[...]</span>` in `src/v8/pages/` with the real text (drop the span), and put the doctor's portrait `<img>` in the About page figure
- `concepts/` — editable sources for the early glass and particle concept pages (artifact format, no `<html>` wrapper)
- `notes/` — site review and redesign suggestions (not published)

Three.js 0.160.0 is vendored in `site/vendor/`, so the site has no runtime CDN dependency besides Google Fonts.

## Hosting on Netlify

Netlify publishes `site/` as it is (no build step) and runs the code in `netlify/`:

| What | Where | Address |
|---|---|---|
| Booking and admin API | `netlify/functions/api.mjs` | `/api/*` |
| Uploaded photos | `netlify/functions/media.mjs` | `/media/:id` |
| The v8 pages, with the doctor's edits applied | `netlify/edge-functions/pages.mjs` | `/v8/*` |
| Storage | `netlify/lib/store.mjs` | Netlify Blobs |
| Shared logic (dates, settings, calendars) | `netlify/lib/core.mjs` | — |
| Sign-in | `netlify/lib/auth.mjs` | — |

- **The admin password is `admin`** until you set one. To change it: Netlify → Site configuration → Environment variables → add `ADMIN_PASSWORD`. Changing it signs everyone out. Nothing needs redeploying.
- **Admin area** at `/admin/` (`site/admin/`): bookings, messages, website text and photo editing (English and Chinese pages separately), availability (weekly hours, blocked days such as EZCall work days, visit types) and clinic details.
- **Online booking** on the v8 Book page (`site/v8/assets/booking.js`), no patient account needed.
- **Messages**: the "Send the doctor a message" box in the v8 footer; messages appear in the admin's Messages tab.
- **Storage** is Netlify Blobs — nothing to set up, and it is on by default for every site. Bookings, messages, settings, website edits and uploaded photos all live there, not in this repo, so they survive deploys. One caveat is written up at the top of `netlify/lib/store.mjs`: Netlify Blobs has no compare-and-swap, so two bookings made within a few tens of milliseconds of each other can collide. The code writes and reads back to catch this, which covers all but the narrowest window.
- **Google Calendar (optional)**: add the service account's JSON key file as the `GOOGLE_SERVICE_ACCOUNT_KEY` environment variable, share each calendar with the service account's email ("Make changes to events"), then add the calendars under Admin → Availability → Google Calendar. Any number of calendars can block online booking: every event counts (Busy or Free, all-day included), except cancelled or declined ones; new bookings are added to the one chosen as "Add new bookings to", and cancellations remove them. The admin Schedule shows bookings, blocked time and each calendar's busy time. `GOOGLE_API_BASE` / `GOOGLE_TOKEN_URL` exist only for local testing against a stand-in server; never set them in Netlify.
- **Apple Calendar / iCloud (optional)**: make an app-specific password at appleid.apple.com (Sign-In and Security → App-Specific Passwords), then add two environment variables: `APPLE_ID` (the Apple ID email) and `APPLE_APP_PASSWORD`. In Admin → Availability → Apple Calendar, click **Find my calendars**, tick the ones whose events should block online booking (Busy / Free / All-day, like Google), optionally choose one for new bookings, and press Save. The site reads iCloud over CalDAV and only ever sends the password to `*.icloud.com`. Events added to iCloud always use minimal details (Apple doesn't sign HIPAA agreements). To disconnect, delete the app-specific password. `APPLE_CALDAV_URL` exists only for local testing against a stand-in server; never set it in Netlify.
- **Calendar links (optional)**: for calendars the doctor only subscribes to, such as EZCall shifts (Google lists them under "Other calendars" and won't share them with the service account), paste the calendar's iCal subscribe link (webcal:// or …ics) under Admin → Availability → Settings → Calendar links. Their events close online booking; bookings are not added to them. The link is kept in the admin settings only.
- Edits made in the admin are applied when pages are served; they are not written back to this repo.

### Tests

```
npm install
npm test
```

- `tools/test-render.mjs` — the page rendering, against every real page in `site/v8`. Chiefly: a page with nothing saved in the admin must come out byte-identical.
- `tools/test-api.mjs` — the real functions against an in-memory Netlify Blobs (`tools/blobs-stub.mjs`): sign-in, settings, website edits, photo upload, booking, messages, rate limits, and ten patients booking the same slot at once. `BLOBS_LATENCY_MS=25 npm run test:api` widens the simulated network delay.
- `tools/test-i18n.mjs` — the admin translates server messages by their exact English text, so this checks none of those messages has been reworded out from under its translation.

None of them needs a Netlify account.

### The old Cloudflare version

`worker/index.js` and `wrangler.jsonc` are the previous Cloudflare Workers version, kept so it can be deployed again if wanted. Nothing reads them while the site is on Netlify. It stored everything in one SQLite-backed Durable Object; that is what `netlify/lib/store.mjs` replaces.
