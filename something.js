(() => {
  // Replace with your Google Gemini API key or set window.GEMINI_API_KEY before running
  const GEMINI_API_KEY = window.GEMINI_API_KEY || "YOUR_GEMINI_API_KEY_HERE";

  window.autoSolve = async () => {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === "YOUR_GEMINI_API_KEY_HERE") {
      console.error("Please configure GEMINI_API_KEY in something.js or set window.GEMINI_API_KEY before calling autoSolve().");
      return;
    }

    console.log("--- Starting autoSolve ---");

    const bodyText = document.body.innerText;

    // 1. Extract Question Text
    let questionText = "";
    const qMatch = bodyText.match(/Question\s+\d+\s+of\s+\d+[\s\S]*?(?=Choices)/i);
    if (qMatch) {
      questionText = qMatch[0].trim();
    } else {
      const qEl = document.querySelector('div[class*="question"], h3, .question-text');
      questionText = qEl ? qEl.innerText.trim() : "Database Question";
    }

    // 2. Extract Choices
    const afterChoices = bodyText.split(/Choices[^\n]*/i)[1] || "";
    const choicesBlock = afterChoices.split(/©|Submit Answer|Previous Question|Version\s+\d/i)[0] || "";

    const choiceTexts = choicesBlock
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 8);

    console.log("Extracted Question:\n", questionText);
    console.log(`Extracted Choices (${choiceTexts.length}):`, choiceTexts);

    if (choiceTexts.length < 2) {
      console.error("Could not parse choices from page.");
      return;
    }

    // 3. Query Gemini
    const prompt = `You are an expert taking an Oracle Database quiz.
Question details:
${questionText}

Choices:
${choiceTexts.map((c, i) => `[${i + 1}] ${c}`).join('\n')}

Respond ONLY with the exact number of the correct option (e.g. 1, 2, 3, or 4). Do not provide any other text.`;

    try {
      console.log("Calling Gemini API...");
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          signal: controller.signal
        }
      );
      clearTimeout(timeoutId);

      console.log("HTTP Status:", res.status);
      const data = await res.json();
      console.log("API Response received:", data);

      if (data.error) {
        console.error("Gemini API Error:", data.error.message);
        return;
      }

      const raw = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
      const match = raw.match(/\d+/);
      if (!match) {
        console.error("Could not parse index from response:", raw);
        return;
      }

      const selectedIdx = parseInt(match[0], 10) - 1;
      const targetText = choiceTexts[selectedIdx];
      console.log(`Gemini selected [${selectedIdx + 1}]: "${targetText}"`);

      // 4. Click the choice (use first 25 chars for robust matching)
      const searchSnippet = targetText.slice(0, 25).trim();
      const allElements = Array.from(document.querySelectorAll('*'));
      const matchingEls = allElements.filter(el => el.innerText && el.innerText.includes(searchSnippet));

      matchingEls.sort((a, b) => a.innerText.length - b.innerText.length);
      const deepest = matchingEls[0];

      if (!deepest) {
        console.error("DOM element not found for:", searchSnippet);
        return;
      }

      // Click the input or container
      const targetClickable = deepest.querySelector('input') || deepest.closest('label') || deepest.closest('div') || deepest;
      targetClickable.click();
      targetClickable.dispatchEvent(new Event('change', { bubbles: true }));
      targetClickable.dispatchEvent(new Event('input', { bubbles: true }));
      console.log("Option clicked!");

      // 5. Submit after 400ms
      setTimeout(() => {
        const buttons = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
        const submitBtn = buttons.find(b => (b.innerText || b.value || '').toLowerCase().includes("submit answer"));

        if (submitBtn) {
          submitBtn.click();
          console.log("Submit button clicked!");
        } else {
          console.warn("Submit button not found.");
        }
      }, 400);

    } catch (err) {
      console.error("Request Failed:", err.name === 'AbortError' ? 'Network Timeout (10s)' : err);
    }
  };

  console.log("autoSolve() updated! Run autoSolve() now.");
})();
