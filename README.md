# PocketWise

This was my Software Engineering assignment (Assignment 01 - Build and Deploy a Small Application). The actual point of the assignment wasn't really the app itself - it was to learn what DevOps actually means and get hands-on with a basic CI/CD workflow using Git and GitHub Actions. PocketWise (a small budget tracker) was just the app I picked to practice that on.

**Live app:** https://qasim2k7.github.io/PocketWise/

## What this project was actually about

Before this I only knew "DevOps" as a buzzword. This assignment forced me to actually do it end to end:

- write code locally
- track it with Git, with proper commit history (not just one giant commit at the end)
- push to GitHub
- set up a CI pipeline with GitHub Actions that automatically checks the code every time I push
- intentionally break something, watch CI catch it and fail, then fix it and watch it pass
- deploy automatically to a live URL with GitHub Pages

So the workflow itself was the assignment. The app was just something to build so there was actual code to run this workflow on.

## The app (PocketWise)

Since I needed something real to deploy, I built a simple budget/pocket money tracker for students - no login, no backend, just open it in a browser:

- set a monthly budget, balance goes down as you log expenses
- add expenses/pocket money with category, description, date, amount
- customizable quick-add buttons for repeat expenses (lunch, tea, rickshaw etc.)
- add your own categories with emoji
- a circle chart showing spent vs saved
- days-left-in-month + safe-to-spend-per-day calculation
- low balance warning
- searchable/filterable/sortable transaction history with pagination
- undo on delete

Just HTML, CSS and JS, no frameworks. Data is saved in localStorage.

## The DevOps part (this is the main thing)

```
.github/workflows/ci.yml
```

This runs automatically on every push to `main` and checks:
- the required files exist (index.html, style.css, script.js)
- script.js has no syntax errors (`node --check`)
- basic HTML validation with htmlhint

If any check fails, GitHub shows a red X against that commit instead of a green check. I deliberately broke `script.js` at one point (added a bad line on purpose), pushed it, watched CI fail, then fixed it and pushed again to see it pass - both runs are visible in the Actions tab.

After that, GitHub Pages auto-deploys `main` to the live link above. So the full loop is: push code -> CI checks it -> if it passes, the live site updates automatically. No manual deployment step.

## Files

```
index.html
style.css
script.js
emoji-data.js
.github/workflows/ci.yml   <- the actual CI/CD pipeline
```

## Things I actually learned

- What CI is for in practice, not just in theory - it's not about "testing" in a fancy sense, it's about catching dumb mistakes automatically before they reach anything live
- Git commit history matters - I had to actually think about what counts as "one meaningful commit" instead of just committing everything at the end
- GitHub Actions YAML is extremely picky about formatting. I lost close to an hour to a hidden BOM (byte-order-mark) character in my workflow file that gave a useless "no event triggers defined" error with no obvious cause
- CI failing isn't a bad thing - it's the whole point. A red X on a bad commit is the pipeline doing its job
- Deployment issues aren't always your code's fault - the live site failed on a friend's phone and it turned out to be a DNS issue with their carrier, nothing to do with PocketWise at all. Took a while to figure out it wasn't a bug I needed to fix.

## Running it locally

Clone the repo, open `index.html` in a browser (or use Live Server in VS Code). No installs needed for the app itself.

## Notes on security

Since PocketWise has no backend, I focused on not trusting input blindly - amounts/dates/category names are validated before use, nothing is inserted into the page as raw HTML, and there's a Content-Security-Policy tag as an extra layer.
