# Project showcase website

This Astro site is separate from the dining app. It builds a static showcase
into the repository's existing `docs/` folder; it does not run the app or its
backend. The Vite build is configured not to empty that folder, preserving the
existing self-hosting guide and screenshots. Old generated assets may remain
after a rebuild.

## Run and publish

1. Install Node.js 22.16 or newer, then from `site/` run `npm ci`.
2. In `astro.config.mjs`, replace `YOUR-REPO-NAME` with the exact GitHub
   repository name (the current remote is `ailt-hku-food`). For a user or
   organization site hosted at the root, use `base: '/'` instead.
3. Run `npm run dev` for local development, or `npm run build` to generate
   the static site in `../docs`. Run `npm run preview` to preview the build.
4. Commit `site/` and the generated `docs/` files, push to GitHub, and select
   the branch and `/docs` folder under repository **Settings → Pages**.
   The site will then be available at the URL shown in GitHub Pages settings.

The empty `public/.nojekyll` file is copied into `docs/` at build time.
Do not put API keys or other secrets in this public site or `docs/`.

## Add your own content

- Replace the five screenshot placeholders in `src/pages/index.astro` with
  your images. Place image files in `public/` and use
  `${import.meta.env.BASE_URL}your-image.png` for their URLs.
- Replace the video placeholder with your demo video or a link to it. If using
  a local file, place it in `public/` and prefix its URL with `BASE_URL` too.
  Update the footer's "Demo video — coming soon" link if appropriate.
- Add team members in the footer of `src/pages/index.astro`.
- The GitHub link is based on the repository's current remote; update `repo`
  in `src/pages/index.astro` if your repository changes.

Rebuild after editing so the committed `docs/` output includes your changes.
The interactive preview is illustrative only; it does not call the app or
search the dataset.
