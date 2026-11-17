# Quiz Helper — OpenRouter + Chrome extension

Press one button on a practice-quiz question. The extension screenshots that
question, asks an OpenRouter model that already has your course files in the chat,
and shows the answer in a small panel in the top corner. With "Auto-select the
answer" on, it also ticks the chosen option(s) for you — it never presses Submit,
you do that yourself. Each answer is also saved (with its screenshot) to
a local folder. Built for Microsoft Forms and Wooclap; works on Moodle-style
pages too.

## How it works
- You add your course files once (options page). PDFs and pptx/docx/txt/md are
  read and turned into text right there in the browser — no size limit, no cost.
  (A scanned PDF with no text layer is kept as-is and parsed by OpenRouter OCR
  instead; pick "Mistral OCR" in options for those.)
- When you pick a course, the extension primes it once. For text PDFs this is
  instant (the text is already extracted); only scanned PDFs need a one-time
  OpenRouter OCR pass. Either way it runs before any question.
- Each question is the next turn in that same chat (files stay in context). A
  question already answered this session is re-shown from cache and is **not**
  sent again — jumping back and forth between questions costs nothing.

## Setup
1. Get an OpenRouter API key: https://openrouter.ai/keys
2. chrome://extensions → Developer mode → Load unpacked → pick the `extension` folder.
3. Popup → "Manage courses & API key":
   - Paste the API key, Save.
   - "Load list", pick a model with image input (so screenshots are used).
   - Create a course, add its files (PDF mostly; pptx/docx/txt/md/images also fine).

## Daily use
- Open the quiz page, open the popup, pick the course. It primes automatically
  (watch the status line) so the first question is fast.
- "Solve current question" (or Alt+Q) answers the one you're on.
  "Solve whole page" answers every question on the page — use this for Microsoft
  Forms pages that show several questions at once (several answers come back).
- Answers appear in a draggable panel in the top corner: Q number, the chosen
  option(s), confidence, and a one-line reason. 🤖 = answered now, ♻ = reused
  from cache, orange = under 50% confidence. Click a row to scroll to that question.
- "New session" clears the chat + the answered-cache. "Clear panel" just hides
  the panel.

## Saved answers
With "Save screenshots + answers to Downloads" on (default), each answered
question is saved as an image — the question screenshot with the answer written
across the bottom — under `Downloads/QuizHelper/<course>/`. (If screenshots are
off, a `.txt` with the answer is saved instead.)

## Options
- "Also highlight the option on the page" (off by default): outlines the right
  option in green in addition to the corner panel.
- "Auto-select the answer" (popup, off by default): selects the chosen option(s)
  (radio, checkbox, dropdown, or types a text answer), including Wooclap's custom
  choice buttons. It never clicks Submit: check the selection and submit yourself.
- PDF engine: "Cloudflare AI" is free and fine for normal text PDFs. For scanned
  or figure-heavy PDFs switch to "Mistral OCR" (paid, per page).

## Notes & limits
- Keep the quiz tab in front while it runs — the screenshot is of the active tab.
- Figures inside course PDFs aren't sent with the cheap text cache; the
  per-question screenshot still captures any figure shown on the quiz itself.
- Wooclap/MS Forms render options as custom elements; the extractor handles the
  common cases, but if a particular page doesn't parse, send its structure and
  the selectors in content.js can be tuned.
- Everything (key, files, answers) stays in your browser; requests go only to
  openrouter.ai, and saved files go only to your Downloads folder.
