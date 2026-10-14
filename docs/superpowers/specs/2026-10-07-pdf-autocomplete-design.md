# PDF Auto-Complete + Quiz Handoff — Design

Date: 2026-10-07
Status: Approved

## Context

Each course section contains many PDF pages. Each PDF page has a navbar button
("Save and Continue" / "Save and Next") above the viewer that marks the PDF as
viewed and auto-navigates to the next PDF in the same tab. After the final PDF,
a "Start Quiz" button appears (different location than the save button) that
opens the section quiz. The existing quiz flow (extension extracts the question,
posts it to the local relay, operator/loop answers it) already works.

All relevant pages are on `academy.oracle.com`, so the existing content script
(`extension/content.js`, manifest match `https://academy.oracle.com/*`) injects
on PDF pages, the start-quiz page, and quiz pages alike.

## Goal

Click "Save and Continue" on every PDF page and "Start Quiz" at the end,
automatically, with no operator interaction. The quiz itself continues to use
the existing relay flow (operator says `run`, answers loop).

## Design

Add a mode dispatcher at the top of `main()` in `extension/content.js`. First
match wins:

1. **PDF mode** — a `button, a, input[type="button"], input[type="submit"]`
   whose visible text matches `/save\s*(and|&)\s*(continue|next)/i`.
   Behavior: wait until `document.readyState === 'complete'`, then an extra
   `PDF_CLICK_DELAY_MS = 500` (lets the viewer register), then click once.
   Guard flag (`window.__pdfRelayClicked`) prevents a second click. The page
   then navigates itself; the script does nothing else.

2. **Question marker** — page text matches `/question\s*\d/i` → existing quiz
   flow (extract → post → poll → click). Checked BEFORE the start button
   because the site nav shows "Take the Assessment" on quiz pages too.

3. **Start-quiz mode** — a button/link whose visible text matches
   `/(start\s*(the\s*)?quiz|take\s*(an|the)?\s*assessment)/i` (the real button
   reads "Take an Assessment"). Same wait + once-guard + click. Only reached
   when no question marker is present, so it can never hijack a quiz page.

4. **Idle** — none of the above and no question marker: log
   `no quiz question, save button, or start-quiz link — idling` and stop.
   This replaces the current path that posts extraction-failure raw text from
   non-quiz pages that happen to contain form inputs.

Match on normalized visible text (`innerText`, whitespace-collapsed,
case-insensitive). Search interactive elements only (button/a/input), never
whole-page text, to avoid false positives from prose mentioning "save".

## Error handling

- Button found but click does not navigate: nothing further to do; log it.
- Delay/ready-state wait has a hard cap (resolve at 5s even if
  `readyState` never completes) so the script cannot hang silently.
- Extraction-failure handling for quiz pages stays exactly as is.

## Non-goals

- No relay changes; no per-PDF progress reporting to the terminal.
- No retry loops for save/start clicks (single click per page load).
- No changes to `wait.js`, `answer.js`, or `relay.js`.

## Testing

Fake-DOM harness (same technique as the click-resolution tests):

1. PDF page → Save clicked exactly once, no question posted.
2. Start-quiz page → Start Quiz clicked exactly once.
3. Quiz page (question text + Choices) → question posted, no save/start click.
4. Unknown page (no marker, some inputs) → idle log, nothing posted.

Plus `node --check` on all touched files.
